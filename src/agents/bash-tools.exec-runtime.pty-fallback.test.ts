import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ManagedRun, SpawnInput } from "../process/supervisor/index.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";

let listRunningSessions: typeof import("./bash-process-registry.js").listRunningSessions;
let resetProcessRegistryForTests: typeof import("./bash-process-registry.js").resetProcessRegistryForTests;
let runExecProcess: typeof import("./bash-tools.exec-runtime.js").runExecProcess;

const { supervisorSpawnMock } = vi.hoisted(() => ({
  supervisorSpawnMock: vi.fn(),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: supervisorSpawnMock,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

function createSuccessfulRun(input: SpawnInput): ManagedRun {
  input.onStdout?.("ok");
  return {
    runId: input.runId ?? "test-run",
    pid: 1234,
    startedAtMs: Date.now(),
    stdin: {
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    },
    cancel: vi.fn(),
    wait: vi.fn(async () => ({
      reason: "exit" as const,
      exitCode: 0,
      exitSignal: null,
      durationMs: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    })),
  };
}

beforeAll(async () => {
  ({ listRunningSessions, resetProcessRegistryForTests } =
    await import("./bash-process-registry.js"));
  ({ runExecProcess } = await import("./bash-tools.exec-runtime.js"));
});

beforeEach(() => {
  supervisorSpawnMock.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
  vi.clearAllMocks();
});

function runPtyFallback(warnings: string[] = []) {
  return runExecProcess({
    command: "printf ok",
    workdir: process.cwd(),
    env: {},
    usePty: true,
    warnings,
    maxOutput: 20_000,
    pendingMaxOutput: 20_000,
    notifyOnExit: false,
    timeoutSec: 5,
  });
}

test("exec falls back when PTY spawn fails", async () => {
  supervisorSpawnMock
    .mockRejectedValueOnce(new Error("pty spawn failed"))
    .mockImplementationOnce(async (input: SpawnInput) => createSuccessfulRun(input));

  const warnings: string[] = [];
  const handle = await runPtyFallback(warnings);
  const outcome = await handle.promise;

  expect(outcome.status).toBe("completed");
  expect(outcome.aggregated).toContain("ok");
  expect(warnings.join("\n")).toContain("PTY spawn failed");
  expect(supervisorSpawnMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ mode: "pty" }));
  expect(supervisorSpawnMock).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ mode: "child" }),
  );
});

test("exec cleans session state when PTY fallback spawn also fails", async () => {
  supervisorSpawnMock
    .mockRejectedValueOnce(new Error("pty spawn failed"))
    .mockRejectedValueOnce(new Error("child fallback failed"));

  await expect(runPtyFallback()).rejects.toThrow("child fallback failed");

  expect(listRunningSessions()).toHaveLength(0);
});

test("sandbox postcheck uses fresh authority after caller cancellation", async () => {
  supervisorSpawnMock.mockImplementationOnce(async (input: SpawnInput) =>
    createSuccessfulRun(input),
  );
  const caller = new AbortController();
  caller.abort(new Error("caller stopped waiting"));
  const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(async (params) => {
    expect(params.signal).not.toBe(caller.signal);
    expect(params.signal?.aborted).toBe(false);
  });
  const sandbox: BashSandboxConfig = {
    containerName: "sandbox",
    workspaceDir: "/workspace",
    containerWorkdir: "/workspace",
    buildExecSpec: async () => ({
      argv: ["true"],
      env: {},
      stdinMode: "pipe-closed",
      finalizeToken: Object.freeze({}),
    }),
    finalizeExec,
  };

  const handle = await runExecProcess({
    command: "true",
    workdir: process.cwd(),
    env: {},
    sandbox,
    usePty: false,
    warnings: [],
    maxOutput: 20_000,
    pendingMaxOutput: 20_000,
    notifyOnExit: false,
    timeoutSec: 5,
    signal: caller.signal,
  });

  await expect(handle.promise).resolves.toMatchObject({ status: "completed", exitCode: 0 });
  expect(finalizeExec).toHaveBeenCalledOnce();
});

test("sandbox postcheck failure preserves the completed command outcome", async () => {
  supervisorSpawnMock.mockImplementationOnce(async (input: SpawnInput) => {
    const run = createSuccessfulRun(input);
    run.wait = vi.fn(async () => ({
      reason: "exit" as const,
      exitCode: 7,
      exitSignal: null,
      durationMs: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      noOutputTimedOut: false,
    }));
    return run;
  });
  const sandbox: BashSandboxConfig = {
    containerName: "sandbox",
    workspaceDir: "/workspace",
    containerWorkdir: "/workspace",
    buildExecSpec: async () => ({
      argv: ["false"],
      env: {},
      stdinMode: "pipe-closed",
      finalizeToken: Object.freeze({}),
    }),
    finalizeExec: async () => {
      throw new Error("postcheck rejected");
    },
  };

  const handle = await runExecProcess({
    command: "exit 7",
    workdir: process.cwd(),
    env: {},
    sandbox,
    usePty: false,
    warnings: [],
    maxOutput: 20_000,
    pendingMaxOutput: 20_000,
    notifyOnExit: false,
    timeoutSec: 5,
  });

  await expect(handle.promise).resolves.toMatchObject({
    status: "failed",
    failureKind: "runtime-error",
    exitCode: 7,
    timedOut: false,
    reason: expect.stringContaining("Command completed with exit code 7"),
  });
});

test("sandbox postcheck failure preserves a supervisor timeout outcome", async () => {
  supervisorSpawnMock.mockImplementationOnce(async (input: SpawnInput) => {
    const run = createSuccessfulRun(input);
    run.wait = vi.fn(async () => ({
      reason: "timeout" as const,
      exitCode: null,
      exitSignal: "SIGTERM" as const,
      durationMs: 10,
      stdout: "",
      stderr: "",
      timedOut: true,
      noOutputTimedOut: false,
    }));
    return run;
  });
  const sandbox: BashSandboxConfig = {
    containerName: "sandbox",
    workspaceDir: "/workspace",
    containerWorkdir: "/workspace",
    buildExecSpec: async () => ({
      argv: ["sleep", "10"],
      env: {},
      stdinMode: "pipe-closed",
      finalizeToken: Object.freeze({}),
    }),
    finalizeExec: async () => {
      throw new Error("postcheck after timeout rejected");
    },
  };

  const handle = await runExecProcess({
    command: "sleep 10",
    workdir: process.cwd(),
    env: {},
    sandbox,
    usePty: false,
    warnings: [],
    maxOutput: 20_000,
    pendingMaxOutput: 20_000,
    notifyOnExit: false,
    timeoutSec: 1,
  });

  await expect(handle.promise).resolves.toMatchObject({
    status: "failed",
    failureKind: "runtime-error",
    exitCode: null,
    timedOut: true,
    reason: expect.stringContaining("postcheck after timeout rejected"),
  });
});

test("sandbox postcheck runs when the supervisor wait rejects", async () => {
  const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(async () => {});
  supervisorSpawnMock.mockImplementationOnce(async (input: SpawnInput) => {
    const run = createSuccessfulRun(input);
    run.wait = vi.fn(async () => {
      throw new Error("supervisor wait failed");
    });
    return run;
  });
  const sandbox: BashSandboxConfig = {
    containerName: "sandbox",
    workspaceDir: "/workspace",
    containerWorkdir: "/workspace",
    buildExecSpec: async () => ({
      argv: ["true"],
      env: {},
      stdinMode: "pipe-closed",
      finalizeToken: Object.freeze({}),
    }),
    finalizeExec,
  };

  const handle = await runExecProcess({
    command: "true",
    workdir: process.cwd(),
    env: {},
    sandbox,
    usePty: false,
    warnings: [],
    maxOutput: 20_000,
    pendingMaxOutput: 20_000,
    notifyOnExit: false,
    timeoutSec: 5,
  });

  await expect(handle.promise).resolves.toMatchObject({
    status: "failed",
    failureKind: "runtime-error",
    reason: expect.stringContaining("supervisor wait failed"),
  });
  expect(finalizeExec).toHaveBeenCalledOnce();
});

test("sandbox postcheck runs when process spawn fails", async () => {
  const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(async () => {});
  supervisorSpawnMock.mockRejectedValueOnce(new Error("sandbox spawn failed"));
  const sandbox: BashSandboxConfig = {
    containerName: "sandbox",
    workspaceDir: "/workspace",
    containerWorkdir: "/workspace",
    buildExecSpec: async () => ({
      argv: ["true"],
      env: {},
      stdinMode: "pipe-closed",
      finalizeToken: Object.freeze({}),
    }),
    finalizeExec,
  };

  await expect(
    runExecProcess({
      command: "true",
      workdir: process.cwd(),
      env: {},
      sandbox,
      usePty: false,
      warnings: [],
      maxOutput: 20_000,
      pendingMaxOutput: 20_000,
      notifyOnExit: false,
      timeoutSec: 5,
    }),
  ).rejects.toThrow("sandbox spawn failed");
  expect(finalizeExec).toHaveBeenCalledOnce();
});
