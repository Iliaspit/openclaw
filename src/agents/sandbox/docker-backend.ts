import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPrimaryAndSecondaryAggregateError } from "../aggregate-error.js";
import { buildDockerExecArgs } from "../bash-tools.shared.js";
import {
  resolveDelegationGuardConfig,
  resolveDelegationGuardPrincipal,
} from "../delegation/policy.js";
import type { SandboxBackendCommandParams } from "./backend-handle.types.js";
import type {
  CreateSandboxBackendParams,
  SandboxBackendHandle,
  SandboxBackendManager,
} from "./backend.types.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  assertGuardedVerifierExecutionInputs,
  dockerContainerState,
  ensureSandboxContainer,
  execDocker,
  execDockerRaw,
  isProvenDockerContainerNotFound,
} from "./docker.js";

const GUARDED_VERIFIER_EXECUTION_CHECK_DEADLINE_MS = 60_000;

async function runMandatoryPostExecCheck(
  afterExec: (signal?: AbortSignal, deadlineMs?: number) => Promise<void>,
  deadlineMs = GUARDED_VERIFIER_EXECUTION_CHECK_DEADLINE_MS,
): Promise<void> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error("Guarded verifier post-execution validation exceeded its deadline.");
      controller.abort(error);
      reject(error);
    }, deadlineMs);
    timeout.unref();
  });
  try {
    await Promise.race([afterExec(controller.signal, deadlineMs), deadline]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function resolveConfiguredDockerRuntimeImage(params: {
  config: OpenClawConfig;
  agentId?: string;
  configLabelKind?: string;
}): string {
  const sandboxCfg = resolveSandboxConfigForAgent(params.config, params.agentId);
  switch (params.configLabelKind) {
    case "BrowserImage":
      return sandboxCfg.browser.image;
    case "Image":
    case undefined:
    default:
      if (params.agentId) {
        const guard = resolveDelegationGuardConfig(params.config);
        const principal = guard
          ? resolveDelegationGuardPrincipal(guard, params.agentId)
          : undefined;
        if (
          guard?.mode === "enforce" &&
          principal?.kind === "worker" &&
          (principal.role === "tester" || principal.role === "reviewer")
        ) {
          const publishedImageId = process.env.OPENCLAW_VERIFIER_IMAGE_ID?.trim() ?? "";
          return /^sha256:[a-f0-9]{64}$/u.test(publishedImageId)
            ? publishedImageId
            : "missing-guarded-verifier-image";
        }
      }
      return sandboxCfg.docker.image;
  }
}

export async function createDockerSandboxBackend(
  params: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  const ensured = await ensureSandboxContainer({
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    cfg: params.cfg,
  });
  const beforeExec = async (
    signal?: AbortSignal,
    deadlineMs = GUARDED_VERIFIER_EXECUTION_CHECK_DEADLINE_MS,
  ) => {
    if (params.beforeExec) {
      await params.beforeExec(signal, deadlineMs);
    }
    const execution = ensured.guardedVerifierExecution;
    if (execution) {
      await assertGuardedVerifierExecutionInputs({
        containerId: ensured.containerId,
        configHash: execution.configHash,
        runtimeIdentity: execution.runtimeIdentity,
        authorization: execution.authorization,
        workspaceDir: execution.workspaceDir,
        workspaceMountSource: execution.workspaceMountSource,
        workdir: execution.workdir,
        tmpfs: execution.tmpfs,
        signal,
        deadlineMs,
      });
    }
    // The Docker checks above may take time. Re-resolve the protected
    // assignment/candidate/workspace after them so execution never proceeds on
    // authorization that became stale while inputs were being inspected.
    if (params.beforeExec && execution) {
      await params.beforeExec(signal, deadlineMs);
    }
  };
  return createDockerSandboxBackendHandle({
    containerId: ensured.containerId,
    containerName: ensured.containerName,
    workdir: params.cfg.docker.workdir,
    env: params.cfg.docker.env,
    image: params.cfg.docker.image,
    beforeExec: params.beforeExec || ensured.guardedVerifierExecution ? beforeExec : undefined,
    afterExec: ensured.guardedVerifierExecution ? beforeExec : undefined,
  });
}

export function createDockerSandboxBackendHandle(params: {
  containerId: string;
  containerName: string;
  workdir: string;
  env?: Record<string, string>;
  image: string;
  beforeExec?: (signal?: AbortSignal, deadlineMs?: number) => Promise<void>;
  afterExec?: (signal?: AbortSignal, deadlineMs?: number) => Promise<void>;
}): SandboxBackendHandle {
  const pendingFinalizers = new WeakSet<object>();
  const afterExec = params.afterExec;
  return {
    id: "docker",
    runtimeId: params.containerId,
    runtimeLabel: params.containerName,
    workdir: params.workdir,
    env: params.env,
    configLabel: params.image,
    configLabelKind: "Image",
    capabilities: {
      browser: true,
    },
    async buildExecSpec({ command, workdir, env, usePty, signal, verificationDeadlineMs }) {
      if (params.beforeExec) {
        await params.beforeExec(signal, verificationDeadlineMs);
      }
      const finalizeToken = afterExec ? Object.freeze({}) : undefined;
      if (finalizeToken) {
        pendingFinalizers.add(finalizeToken);
      }
      return {
        argv: [
          "docker",
          ...buildDockerExecArgs({
            containerName: params.containerId,
            command,
            workdir: workdir ?? params.workdir,
            env,
            tty: usePty,
          }),
        ],
        env: process.env,
        stdinMode: usePty ? "pipe-open" : "pipe-closed",
        finalizeToken,
      };
    },
    finalizeExec: afterExec
      ? async ({ token, verificationDeadlineMs }) => {
          if (!token || typeof token !== "object" || !pendingFinalizers.delete(token)) {
            throw new Error(
              "Guarded verifier execution finalizer authority is missing, forged, or already used.",
            );
          }
          await runMandatoryPostExecCheck(
            afterExec,
            verificationDeadlineMs ?? GUARDED_VERIFIER_EXECUTION_CHECK_DEADLINE_MS,
          );
        }
      : undefined,
    async runShellCommand(command) {
      if (params.beforeExec) {
        await params.beforeExec(command.signal);
      }
      let result: Awaited<ReturnType<typeof runDockerSandboxShellCommand>>;
      try {
        result = await runDockerSandboxShellCommand({
          containerName: params.containerId,
          ...command,
        });
      } catch (commandError) {
        try {
          if (afterExec) {
            await runMandatoryPostExecCheck(afterExec);
          }
        } catch (finalizationCause) {
          throw createPrimaryAndSecondaryAggregateError({
            primary: commandError,
            secondary: finalizationCause,
            secondaryMessage: "Guarded verifier post-execution validation failed.",
            aggregateMessage: "Guarded verifier command and post-execution validation both failed.",
          });
        }
        throw commandError;
      }
      if (afterExec) {
        await runMandatoryPostExecCheck(afterExec);
      }
      return result;
    },
  };
}

export function runDockerSandboxShellCommand(
  params: {
    containerName: string;
  } & SandboxBackendCommandParams,
) {
  const dockerArgs = [
    "exec",
    "-i",
    params.containerName,
    "sh",
    "-c",
    params.script,
    "openclaw-sandbox-fs",
  ];
  if (params.args?.length) {
    dockerArgs.push(...params.args);
  }
  return execDockerRaw(dockerArgs, {
    input: params.stdin,
    allowFailure: params.allowFailure,
    signal: params.signal,
  });
}

export const dockerSandboxBackendManager: SandboxBackendManager = {
  async describeRuntime({ entry, config, agentId }) {
    const runtimeRef = entry.runtimeId?.trim() || entry.containerName;
    const state = await dockerContainerState(runtimeRef);
    let actualConfigLabel = entry.image;
    if (state.exists) {
      try {
        const result = await execDocker(["inspect", "-f", "{{.Config.Image}}", runtimeRef], {
          allowFailure: true,
        });
        if (result.code === 0) {
          actualConfigLabel = result.stdout.trim() || actualConfigLabel;
        }
      } catch {
        // ignore inspect failures
      }
    }
    const configuredImage = resolveConfiguredDockerRuntimeImage({
      config,
      agentId,
      configLabelKind: entry.configLabelKind,
    });
    return {
      running: state.running,
      actualConfigLabel,
      configLabelMatch: actualConfigLabel === configuredImage,
    };
  },
  async removeRuntime({ entry }) {
    const immutableId = entry.runtimeId?.trim();
    if (immutableId) {
      if (!/^[a-f0-9]{64}$/u.test(immutableId)) {
        throw new Error("Sandbox registry contains a malformed immutable runtime identity.");
      }
      const state = await dockerContainerState(immutableId);
      if (state.exists) {
        await execDocker(["rm", "-f", immutableId]);
      }
      return;
    }
    const inspect = await execDocker(["inspect", "-f", "{{.Id}}", entry.containerName], {
      allowFailure: true,
      maxOutputBytes: 1024,
      timeoutMs: 5_000,
    });
    if (inspect.code !== 0) {
      if (isProvenDockerContainerNotFound(inspect.stderr)) {
        return;
      }
      throw new Error(
        `Could not establish whether legacy sandbox runtime ${entry.containerName} exists.`,
      );
    }
    const capturedId = inspect.stdout.trim();
    if (!/^[a-f0-9]{64}$/u.test(capturedId)) {
      throw new Error("Legacy sandbox runtime resolved to a malformed immutable identity.");
    }
    await execDocker(["rm", "-f", capturedId]);
  },
};
