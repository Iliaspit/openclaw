import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createDelegationGuardTestConfig } from "../delegation/test-helpers.js";

const dockerMocks = vi.hoisted(() => ({
  dockerContainerState: vi.fn(),
  ensureSandboxContainer: vi.fn(),
  execDocker: vi.fn(),
  execDockerRaw: vi.fn(),
}));

vi.mock("./docker.js", async () => {
  const actual = await vi.importActual<typeof import("./docker.js")>("./docker.js");
  return {
    ...actual,
    dockerContainerState: dockerMocks.dockerContainerState,
    ensureSandboxContainer: dockerMocks.ensureSandboxContainer,
    execDocker: dockerMocks.execDocker,
    execDockerRaw: dockerMocks.execDockerRaw,
  };
});

const { createDockerSandboxBackendHandle, dockerSandboxBackendManager } =
  await import("./docker-backend.js");

function createConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope: "session",
          workspaceAccess: "none",
          docker: {
            image: "openclaw-sandbox:bookworm-slim",
          },
          browser: {
            enabled: true,
            image: "openclaw-sandbox-browser:bookworm-slim",
          },
        },
      },
      list: [],
    },
  };
}

describe("docker sandbox backend manager", () => {
  beforeEach(() => {
    dockerMocks.dockerContainerState.mockReset();
    dockerMocks.ensureSandboxContainer.mockReset();
    dockerMocks.execDocker.mockReset();
    dockerMocks.execDockerRaw.mockReset();
    dockerMocks.dockerContainerState.mockResolvedValue({
      exists: true,
      running: true,
    });
    dockerMocks.execDocker.mockResolvedValue({
      code: 0,
      stdout: "unused-image",
      stderr: "",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("matches ordinary sandbox runtimes against sandbox.docker.image", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce({
      code: 0,
      stdout: "openclaw-sandbox:bookworm-slim\n",
      stderr: "",
    });

    const result = await dockerSandboxBackendManager.describeRuntime({
      entry: {
        containerName: "sandbox-1",
        backendId: "docker",
        runtimeLabel: "sandbox-1",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "stale-entry-image",
        configLabelKind: "Image",
      },
      config: createConfig(),
      agentId: "coder",
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "openclaw-sandbox:bookworm-slim",
      configLabelMatch: true,
    });
  });

  it("matches browser runtimes against sandbox.browser.image", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce({
      code: 0,
      stdout: "openclaw-sandbox-browser:bookworm-slim\n",
      stderr: "",
    });

    const result = await dockerSandboxBackendManager.describeRuntime({
      entry: {
        containerName: "browser-1",
        backendId: "docker",
        runtimeLabel: "browser-1",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "stale-entry-image",
        configLabelKind: "BrowserImage",
      },
      config: createConfig(),
      agentId: "coder",
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "openclaw-sandbox-browser:bookworm-slim",
      configLabelMatch: true,
    });
  });

  it("defaults docker-backed runtime matching to sandbox.docker.image when label kind is missing", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce({
      code: 0,
      stdout: "openclaw-sandbox:bookworm-slim\n",
      stderr: "",
    });

    const result = await dockerSandboxBackendManager.describeRuntime({
      entry: {
        containerName: "sandbox-legacy",
        backendId: "docker",
        runtimeLabel: "sandbox-legacy",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "stale-entry-image",
      },
      config: createConfig(),
      agentId: "coder",
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "openclaw-sandbox:bookworm-slim",
      configLabelMatch: true,
    });
  });

  it("matches guarded verifier runtimes against the dedicated verifier image", async () => {
    const imageId = `sha256:${"a".repeat(64)}`;
    vi.stubEnv("OPENCLAW_VERIFIER_IMAGE_ID", imageId);
    dockerMocks.execDocker.mockResolvedValueOnce({
      code: 0,
      stdout: `${imageId}\n`,
      stderr: "",
    });
    dockerMocks.execDocker.mockResolvedValueOnce({
      code: 0,
      stdout: `${imageId}\n`,
      stderr: "",
    });

    const result = await dockerSandboxBackendManager.describeRuntime({
      entry: {
        containerName: "verifier-1",
        backendId: "docker",
        runtimeLabel: "verifier-1",
        sessionKey: "agent:tester:subagent:verifier-1",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw-sandbox-verifier:bookworm-slim",
        configLabelKind: "Image",
      },
      config: createDelegationGuardTestConfig(),
      agentId: "tester",
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: imageId,
      configLabelMatch: true,
    });
  });

  it("removes legacy runtimes only after capturing an immutable container ID", async () => {
    const capturedId = "f".repeat(64);
    dockerMocks.execDocker
      .mockResolvedValueOnce({ code: 0, stdout: `${capturedId}\n`, stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

    await dockerSandboxBackendManager.removeRuntime({
      entry: {
        containerName: "sandbox-legacy",
        backendId: "docker",
        runtimeLabel: "sandbox-legacy",
        sessionKey: "agent:coder:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "openclaw-sandbox:bookworm-slim",
      },
      config: createConfig(),
    });

    expect(dockerMocks.execDocker).toHaveBeenNthCalledWith(
      1,
      ["inspect", "-f", "{{.Id}}", "sandbox-legacy"],
      { allowFailure: true, maxOutputBytes: 1024, timeoutMs: 5_000 },
    );
    expect(dockerMocks.execDocker).toHaveBeenNthCalledWith(2, ["rm", "-f", capturedId]);
  });

  it("retains legacy cleanup ownership when Docker cannot prove absence", async () => {
    dockerMocks.execDocker.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "daemon unavailable",
    });

    await expect(
      dockerSandboxBackendManager.removeRuntime({
        entry: {
          containerName: "sandbox-legacy",
          backendId: "docker",
          runtimeLabel: "sandbox-legacy",
          sessionKey: "agent:coder:main",
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "openclaw-sandbox:bookworm-slim",
        },
        config: createConfig(),
      }),
    ).rejects.toThrow("establish whether");
  });

  it("propagates ambiguous exact-runtime inspection and removal failures", async () => {
    const entry = {
      containerName: "sandbox-exact",
      runtimeId: "e".repeat(64),
      backendId: "docker",
      runtimeLabel: "sandbox-exact",
      sessionKey: "agent:coder:main",
      createdAtMs: 1,
      lastUsedAtMs: 1,
      image: "openclaw-sandbox:bookworm-slim",
    };
    dockerMocks.dockerContainerState.mockRejectedValueOnce(new Error("daemon unavailable"));
    await expect(
      dockerSandboxBackendManager.removeRuntime({ entry, config: createConfig() }),
    ).rejects.toThrow("daemon unavailable");

    dockerMocks.dockerContainerState.mockResolvedValueOnce({ exists: true, running: false });
    dockerMocks.execDocker.mockRejectedValueOnce(new Error("remove failed"));
    await expect(
      dockerSandboxBackendManager.removeRuntime({ entry, config: createConfig() }),
    ).rejects.toThrow("remove failed");
  });

  it("runs the guarded verifier finalizer only with its exact execution token", async () => {
    const beforeExec = vi.fn(async () => {});
    const afterExec = vi.fn(async () => {});
    const signal = new AbortController().signal;
    const backend = createDockerSandboxBackendHandle({
      containerId: "c".repeat(64),
      containerName: "verifier",
      workdir: "/workspace",
      image: `sha256:${"a".repeat(64)}`,
      beforeExec,
      afterExec,
    });
    const spec = await backend.buildExecSpec({
      command: "true",
      env: {},
      usePty: false,
      signal,
      verificationDeadlineMs: 1_000,
    });
    await backend.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: spec.finalizeToken,
      signal,
      verificationDeadlineMs: 2_000,
    });
    expect(beforeExec).toHaveBeenCalledWith(signal, 1_000);
    expect(afterExec).toHaveBeenCalledWith(expect.any(AbortSignal), 2_000);
    const postExecSignal = afterExec.mock.calls[0]?.[0];
    expect(postExecSignal).not.toBe(signal);
    expect(postExecSignal?.aborted).toBe(false);
    await expect(
      backend.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: spec.finalizeToken,
      }),
    ).rejects.toThrow("already used");
    await expect(
      backend.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: {},
      }),
    ).rejects.toThrow("finalizer authority");
  });

  it("rejects a finalizer authority minted by another backend handle", async () => {
    const afterExec = vi.fn(async () => {});
    const first = createDockerSandboxBackendHandle({
      containerId: "a".repeat(64),
      containerName: "verifier-a",
      workdir: "/workspace",
      image: `sha256:${"1".repeat(64)}`,
      afterExec,
    });
    const second = createDockerSandboxBackendHandle({
      containerId: "b".repeat(64),
      containerName: "verifier-b",
      workdir: "/workspace",
      image: `sha256:${"2".repeat(64)}`,
      afterExec,
    });
    const spec = await first.buildExecSpec({
      command: "true",
      env: {},
      usePty: false,
    });
    await expect(
      second.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: spec.finalizeToken,
      }),
    ).rejects.toThrow("forged");
    expect(afterExec).not.toHaveBeenCalled();
  });

  it("bounds mandatory post-execution validation with its supervisor signal", async () => {
    const backend = createDockerSandboxBackendHandle({
      containerId: "c".repeat(64),
      containerName: "verifier",
      workdir: "/workspace",
      image: `sha256:${"a".repeat(64)}`,
      afterExec: async (signal) =>
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("postcheck aborted")),
            { once: true },
          );
        }),
    });
    const spec = await backend.buildExecSpec({
      command: "true",
      env: {},
      usePty: false,
    });

    await expect(
      backend.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: spec.finalizeToken,
        verificationDeadlineMs: 5,
      }),
    ).rejects.toThrow("exceeded its deadline");
  });

  it("preserves both command and post-execution validation failures", async () => {
    const commandError = new Error("command failed");
    const finalizationError = new Error("post-check failed");
    dockerMocks.execDockerRaw.mockRejectedValueOnce(commandError);
    const backend = createDockerSandboxBackendHandle({
      containerId: "c".repeat(64),
      containerName: "verifier",
      workdir: "/workspace",
      image: `sha256:${"a".repeat(64)}`,
      afterExec: async () => {
        throw finalizationError;
      },
    });

    const failure = await backend
      .runShellCommand({ script: "false" })
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0]).toBe(commandError);
    expect(aggregate.errors[1]).toMatchObject({
      message: "Guarded verifier post-execution validation failed.",
      cause: finalizationError,
    });
    expect(aggregate.cause).toBe(commandError);
  });

  it("does not reuse an aborted command signal for runShellCommand postchecks", async () => {
    const caller = new AbortController();
    caller.abort(new Error("caller stopped"));
    dockerMocks.execDockerRaw.mockResolvedValueOnce({
      code: 0,
      stdout: "",
      stderr: "",
    });
    const afterExec = vi.fn(async (signal?: AbortSignal) => {
      expect(signal).not.toBe(caller.signal);
      expect(signal?.aborted).toBe(false);
    });
    const backend = createDockerSandboxBackendHandle({
      containerId: "c".repeat(64),
      containerName: "verifier",
      workdir: "/workspace",
      image: `sha256:${"a".repeat(64)}`,
      afterExec,
    });

    await expect(
      backend.runShellCommand({ script: "true", signal: caller.signal }),
    ).resolves.toMatchObject({ code: 0 });
    expect(afterExec).toHaveBeenCalledOnce();
  });
});
