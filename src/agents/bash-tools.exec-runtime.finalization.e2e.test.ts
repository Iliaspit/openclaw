import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";

function buildSandbox(params: {
  argv: string[];
  finalizeExec: NonNullable<BashSandboxConfig["finalizeExec"]>;
}): BashSandboxConfig {
  return {
    containerName: "actual-process-lifecycle",
    workspaceDir: process.cwd(),
    containerWorkdir: process.cwd(),
    buildExecSpec: async () => ({
      argv: params.argv,
      env: process.env,
      stdinMode: "pipe-closed",
      finalizeToken: Object.freeze({}),
    }),
    finalizeExec: params.finalizeExec,
  };
}

async function startActualProcess(params: {
  argv: string[];
  finalizeExec: NonNullable<BashSandboxConfig["finalizeExec"]>;
  timeoutSec?: number | null;
  signal?: AbortSignal;
}) {
  return await runExecProcess({
    command: params.argv.join(" "),
    workdir: process.cwd(),
    env: {},
    sandbox: buildSandbox(params),
    usePty: false,
    warnings: [],
    maxOutput: 20_000,
    pendingMaxOutput: 20_000,
    notifyOnExit: false,
    timeoutSec: params.timeoutSec ?? 5,
    signal: params.signal,
  });
}

afterEach(() => {
  resetProcessRegistryForTests();
});

describe("actual sandbox finalization lifecycle", () => {
  it("runs the mandatory postcheck after caller cancellation", async () => {
    const caller = new AbortController();
    caller.abort(new Error("foreground caller stopped"));
    const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(async (params) => {
      expect(params.signal).not.toBe(caller.signal);
      expect(params.signal?.aborted).toBe(false);
    });
    const run = await startActualProcess({
      argv: [process.execPath, "-e", "process.stdout.write('done')"],
      finalizeExec,
      signal: caller.signal,
    });

    await expect(run.promise).resolves.toMatchObject({ status: "completed", exitCode: 0 });
    expect(finalizeExec).toHaveBeenCalledOnce();
  });

  it("runs the mandatory postcheck after a supervisor deadline", async () => {
    const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(async () => {});
    const run = await startActualProcess({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      finalizeExec,
      timeoutSec: 0.05,
    });

    await expect(run.promise).resolves.toMatchObject({
      status: "failed",
      timedOut: true,
    });
    expect(finalizeExec).toHaveBeenCalledOnce();
  });

  it("awaits postcheck after manual cancellation and socket teardown", async () => {
    const socketRoot = await mkdtemp(path.join(tmpdir(), "openclaw-finalizer-socket-"));
    const socketPath = path.join(socketRoot, "child.sock");
    const finalizeExec = vi.fn<NonNullable<BashSandboxConfig["finalizeExec"]>>(async () => {});
    try {
      const script = [
        "const net=require('node:net');",
        `net.createServer().listen(${JSON.stringify(socketPath)});`,
        "setInterval(() => {}, 1000);",
      ].join("");
      const run = await startActualProcess({
        argv: [process.execPath, "-e", script],
        finalizeExec,
      });
      await expect.poll(() => existsSync(socketPath), { timeout: 5_000 }).toBe(true);
      run.kill();

      await expect(run.promise).resolves.toMatchObject({ status: "failed" });
      expect(finalizeExec).toHaveBeenCalledOnce();
    } finally {
      await rm(socketRoot, { recursive: true, force: true });
    }
  });

  it("contains postcheck errors while preserving the foreground outcome", async () => {
    const run = await startActualProcess({
      argv: [process.execPath, "-e", "process.exit(9)"],
      finalizeExec: async () => {
        throw new Error("postcheck unhandled-path fixture");
      },
    });

    await expect(run.promise).resolves.toMatchObject({
      status: "failed",
      failureKind: "runtime-error",
      exitCode: 9,
      reason: expect.stringContaining("postcheck unhandled-path fixture"),
    });
  });
});
