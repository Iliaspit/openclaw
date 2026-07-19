import { Type } from "typebox";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import {
  appendDelegationRouteEvent,
  authorizeDelegationRoute,
  resolveDelegationCallerAgentId,
  type AuthorizedDelegationRoute,
} from "../delegation/runtime.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { registerSubagentRun } from "../subagent-registry.js";
import {
  SUBAGENT_SPAWN_CONTEXT_MODES,
  SUBAGENT_SPAWN_MODES,
  spawnSubagentDirect,
} from "../subagent-spawn.js";
import {
  describeSessionsSpawnTool,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";

const SESSIONS_SPAWN_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
const SESSIONS_SPAWN_SLICE_ROLES = [
  "implementation",
  "testing",
  "review",
  "qa",
  "full_gate",
] as const;
const SESSIONS_SPAWN_SLICE_CONTINUATIONS = ["default", "same"] as const;
// Keep the schema local to avoid a circular import through acp-spawn/openclaw-tools.
const SESSIONS_SPAWN_ACP_STREAM_TARGETS = ["parent"] as const;
const UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS = [
  "target",
  "transport",
  "channel",
  "to",
  "threadId",
  "thread_id",
  "replyTo",
  "reply_to",
] as const;

type AcpSpawnModule = typeof import("../acp-spawn.js");

let acpSpawnModulePromise: Promise<AcpSpawnModule> | undefined;

async function loadAcpSpawnModule(): Promise<AcpSpawnModule> {
  acpSpawnModulePromise ??= import("../acp-spawn.js");
  return await acpSpawnModulePromise;
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function addRoleToFailureResult<T extends { status: string }>(
  result: T,
  role: string | undefined,
): T | (T & { role: string }) {
  if (!role || (result.status !== "error" && result.status !== "forbidden")) {
    return result;
  }
  return { ...result, role };
}

function resolveTrackedSpawnMode(params: {
  requestedMode?: "run" | "session";
  threadRequested: boolean;
}): "run" | "session" {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  return params.threadRequested ? "session" : "run";
}

export function resolveGuardedSpawnMetadata(
  role: AuthorizedDelegationRoute["assignment"]["role"],
): {
  sandbox: "require";
  sliceRole: (typeof SESSIONS_SPAWN_SLICE_ROLES)[number] | undefined;
} {
  const sliceRole =
    role === "implementer"
      ? "implementation"
      : role === "tester"
        ? "testing"
        : role === "reviewer"
          ? "review"
          : role === "qa"
            ? "qa"
            : undefined;
  return { sandbox: "require", sliceRole };
}

async function cleanupUntrackedAcpSession(sessionKey: string): Promise<void> {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  try {
    await callGateway({
      method: "sessions.delete",
      params: {
        key,
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  label: Type.Optional(Type.String()),
  runtime: optionalStringEnum(SESSIONS_SPAWN_RUNTIMES),
  agentId: Type.Optional(Type.String()),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        'Resume an existing agent session by its ID (e.g. a Codex session UUID from ~/.codex/sessions/). Requires runtime="acp". The agent replays conversation history via session/load instead of starting fresh.',
    }),
  ),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  delegationToken: Type.Optional(
    Type.String({
      minLength: 1,
      description: "One-use runtime token issued by delegation_guard for guarded workers.",
    }),
  ),
  cwd: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  // Back-compat: older callers used timeoutSeconds for this tool.
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  thread: Type.Optional(Type.Boolean()),
  mode: optionalStringEnum(SUBAGENT_SPAWN_MODES),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  sliceRole: optionalStringEnum(SESSIONS_SPAWN_SLICE_ROLES, {
    description:
      'Optional planner slice role. Use "testing" for focused unit/integration validation, "qa" for manual/behavioral QA or the smallest relevant smoke check, and "review" for independent review. Do not use "qa", "testing", or "review" for the full E2E suite; use "full_gate" only for the explicit final gate after focused validation is complete.',
  }),
  sliceContinuation: optionalStringEnum(SESSIONS_SPAWN_SLICE_CONTINUATIONS, {
    description:
      'Optional planner slice continuation. Use "same" only when the user explicitly wants post-green review/QA work to continue the same recovery slice.',
  }),
  sandbox: optionalStringEnum(SESSIONS_SPAWN_SANDBOX_MODES),
  context: optionalStringEnum(SUBAGENT_SPAWN_CONTEXT_MODES, {
    description:
      'Native subagent context mode. Omit or use "isolated" for a clean child session; use "fork" only when the child needs the requester transcript context.',
  }),
  streamTo: optionalStringEnum(SESSIONS_SPAWN_ACP_STREAM_TARGETS),
  lightContext: Type.Optional(
    Type.Boolean({
      description:
        "When true, spawned subagent runs use lightweight bootstrap context. Only applies to runtime='subagent'.",
    }),
  ),

  // Inline attachments (snapshot-by-value).
  // NOTE: Attachment contents are redacted from transcript persistence by sanitizeToolCallInputs.
  attachments: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        content: Type.String(),
        encoding: Type.Optional(optionalStringEnum(["utf8", "base64"] as const)),
        mimeType: Type.Optional(Type.String()),
      }),
      { maxItems: 50 },
    ),
  ),
  attachAs: Type.Optional(
    Type.Object({
      // Where the spawned agent should look for attachments.
      // Kept as a hint; implementation materializes into the child workspace.
      mountPath: Type.Optional(Type.String()),
    }),
  ),
});

export function createSessionsSpawnTool(
  opts?: {
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
    config?: OpenClawConfig;
    effectiveThinking?: string;
  } & SpawnedToolContext,
): AnyAgentTool {
  return {
    label: "Sessions",
    name: "sessions_spawn",
    displaySummary: SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSpawnTool(),
    parameters: SessionsSpawnToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const unsupportedParam = UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS.find((key) =>
        Object.hasOwn(params, key),
      );
      if (unsupportedParam) {
        throw new ToolInputError(
          `sessions_spawn does not support "${unsupportedParam}". Use "message" or "sessions_send" for channel delivery.`,
        );
      }
      const task = readStringParam(params, "task", { required: true });
      const label = readStringParam(params, "label") ?? "";
      const runtime = params.runtime === "acp" ? "acp" : "subagent";
      const requestedAgentId = readStringParam(params, "agentId");
      const resumeSessionId = readStringParam(params, "resumeSessionId");
      let modelOverride = readStringParam(params, "model");
      let thinkingOverrideRaw = readStringParam(params, "thinking");
      const delegationToken = readStringParam(params, "delegationToken");
      const cwd = readStringParam(params, "cwd");
      const mode = params.mode === "run" || params.mode === "session" ? params.mode : undefined;
      const cleanup =
        params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
      let sliceRole = SESSIONS_SPAWN_SLICE_ROLES.includes(
        params.sliceRole as (typeof SESSIONS_SPAWN_SLICE_ROLES)[number],
      )
        ? (params.sliceRole as (typeof SESSIONS_SPAWN_SLICE_ROLES)[number])
        : undefined;
      const sliceContinuation =
        params.sliceContinuation === "same" || params.sliceContinuation === "default"
          ? params.sliceContinuation
          : undefined;
      const expectsCompletionMessage = params.expectsCompletionMessage !== false;
      let sandbox: "inherit" | "require" = params.sandbox === "require" ? "require" : "inherit";
      const context =
        params.context === "fork" || params.context === "isolated" ? params.context : undefined;
      const streamTo = params.streamTo === "parent" ? "parent" : undefined;
      const lightContext = params.lightContext === true;
      if (runtime === "acp" && lightContext) {
        throw new Error("lightContext is only supported for runtime='subagent'.");
      }
      if (runtime === "acp" && context === "fork") {
        throw new Error('context="fork" is only supported for runtime="subagent".');
      }
      // Back-compat: older callers used timeoutSeconds for this tool.
      const timeoutSecondsCandidate =
        typeof params.runTimeoutSeconds === "number"
          ? params.runTimeoutSeconds
          : typeof params.timeoutSeconds === "number"
            ? params.timeoutSeconds
            : undefined;
      const runTimeoutSeconds =
        typeof timeoutSecondsCandidate === "number" && Number.isFinite(timeoutSecondsCandidate)
          ? Math.max(0, Math.floor(timeoutSecondsCandidate))
          : undefined;
      const thread = params.thread === true;
      const attachments = Array.isArray(params.attachments)
        ? (params.attachments as Array<{
            name: string;
            content: string;
            encoding?: "utf8" | "base64";
            mimeType?: string;
          }>)
        : undefined;
      const roleContext = requestedAgentId ? { role: requestedAgentId } : {};

      const cfg = opts?.config ?? loadConfig();
      let guardedRoute: AuthorizedDelegationRoute | undefined;
      try {
        const targetAgentId =
          requestedAgentId ??
          resolveDelegationCallerAgentId({
            agentSessionKey: opts?.agentSessionKey,
            requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          });
        guardedRoute = authorizeDelegationRoute({
          config: cfg,
          agentSessionKey: opts?.agentSessionKey,
          requesterAgentIdOverride: opts?.requesterAgentIdOverride,
          effectiveThinking: opts?.effectiveThinking,
          targetAgentId,
          targetThinking: thinkingOverrideRaw,
          targetModel: modelOverride,
          delegationToken,
          routeKind: "spawn",
        });
      } catch (error) {
        return jsonResult({
          status: "forbidden",
          error: error instanceof Error ? error.message : "Guarded spawn authorization failed.",
          ...roleContext,
        });
      }

      if (guardedRoute) {
        const requiredThinking = guardedRoute.assignment.requiredThinking;
        const requiredModel = guardedRoute.assignment.requiredModel;
        if (runtime !== "subagent") {
          appendDelegationRouteEvent({
            authorized: guardedRoute,
            kind: "route_rejected",
            reason: "guarded workers require the sandboxed subagent runtime",
          });
          return jsonResult({
            status: "forbidden",
            error: "Guarded workers require runtime=subagent.",
            ...roleContext,
          });
        }
        if (resumeSessionId || streamTo) {
          appendDelegationRouteEvent({
            authorized: guardedRoute,
            kind: "route_rejected",
            reason: "guarded worker session/stream override rejected",
          });
          return jsonResult({
            status: "forbidden",
            error: "Guarded worker routes do not permit resume-session or host-stream overrides.",
            ...roleContext,
          });
        }
        if (modelOverride && modelOverride !== requiredModel) {
          appendDelegationRouteEvent({
            authorized: guardedRoute,
            kind: "route_rejected",
            reason: "conflicting guarded worker model override",
          });
          return jsonResult({
            status: "forbidden",
            error: `Guarded assignment requires exact model ${requiredModel}.`,
            ...roleContext,
          });
        }
        if (thinkingOverrideRaw && thinkingOverrideRaw !== requiredThinking) {
          appendDelegationRouteEvent({
            authorized: guardedRoute,
            kind: "route_rejected",
            reason: "conflicting guarded worker thinking override",
          });
          return jsonResult({
            status: "forbidden",
            error: `Guarded assignment requires exact ${requiredThinking} thinking.`,
            ...roleContext,
          });
        }
        const guardedMetadata = resolveGuardedSpawnMetadata(guardedRoute.assignment.role);
        // The assignment token, not planner-supplied generic spawn metadata, owns
        // the guarded role and sandbox. Normalize both before the worker starts.
        sliceRole = guardedMetadata.sliceRole;
        modelOverride = requiredModel;
        thinkingOverrideRaw = requiredThinking;
        sandbox = guardedMetadata.sandbox;
      }

      if (streamTo && runtime !== "acp") {
        return jsonResult({
          status: "error",
          error: `streamTo is only supported for runtime=acp; got runtime=${runtime}`,
          ...roleContext,
        });
      }

      if (resumeSessionId && runtime !== "acp") {
        return jsonResult({
          status: "error",
          error: `resumeSessionId is only supported for runtime=acp; got runtime=${runtime}`,
          ...roleContext,
        });
      }

      if (runtime === "acp") {
        const { isSpawnAcpAcceptedResult, spawnAcpDirect } = await loadAcpSpawnModule();
        if (Array.isArray(attachments) && attachments.length > 0) {
          return jsonResult({
            status: "error",
            error:
              "attachments are currently unsupported for runtime=acp; use runtime=subagent or remove attachments",
            ...roleContext,
          });
        }
        const result = await spawnAcpDirect(
          {
            task,
            label: label || undefined,
            agentId: requestedAgentId,
            resumeSessionId,
            model: modelOverride,
            cwd,
            mode: mode === "run" || mode === "session" ? mode : undefined,
            thread,
            sliceRole,
            sandbox,
            streamTo,
          },
          {
            agentSessionKey: opts?.agentSessionKey,
            agentChannel: opts?.agentChannel,
            agentAccountId: opts?.agentAccountId,
            agentTo: opts?.agentTo,
            agentThreadId: opts?.agentThreadId,
            agentGroupId: opts?.agentGroupId ?? undefined,
            agentGroupSpace: opts?.agentGroupSpace,
            agentMemberRoleIds: opts?.agentMemberRoleIds,
            sandboxed: opts?.sandboxed,
          },
        );
        const childSessionKey = result.childSessionKey?.trim();
        const childRunId = isSpawnAcpAcceptedResult(result) ? result.runId?.trim() : undefined;
        const shouldTrackViaRegistry =
          result.status === "accepted" &&
          Boolean(childSessionKey) &&
          Boolean(childRunId) &&
          streamTo !== "parent";
        if (shouldTrackViaRegistry && childSessionKey && childRunId) {
          const cfg = opts?.config ?? loadConfig();
          const trackedSpawnMode = resolveTrackedSpawnMode({
            requestedMode: result.mode,
            threadRequested: thread,
          });
          const trackedCleanup = trackedSpawnMode === "session" ? "keep" : cleanup;
          const { mainKey, alias } = resolveMainSessionAlias(cfg);
          const requesterInternalKey = opts?.agentSessionKey
            ? resolveInternalSessionKey({
                key: opts.agentSessionKey,
                alias,
                mainKey,
              })
            : alias;
          const requesterDisplayKey = resolveDisplaySessionKey({
            key: requesterInternalKey,
            alias,
            mainKey,
          });
          const requesterOrigin = normalizeDeliveryContext({
            channel: opts?.agentChannel,
            accountId: opts?.agentAccountId,
            to: opts?.agentTo,
            threadId: opts?.agentThreadId,
          });
          try {
            registerSubagentRun({
              runId: childRunId,
              childSessionKey,
              requesterSessionKey: requesterInternalKey,
              requesterOrigin,
              requesterDisplayKey,
              task,
              cleanup: trackedCleanup,
              label: label || undefined,
              sliceRole,
              sliceContinuation,
              runTimeoutSeconds,
              expectsCompletionMessage,
              spawnMode: trackedSpawnMode,
            });
          } catch (err) {
            // Best-effort only: the ACP turn was already started above, so deleting the
            // child session record here does not guarantee the in-flight run was aborted.
            await cleanupUntrackedAcpSession(childSessionKey);
            return jsonResult({
              status: "error",
              error: `Failed to register ACP run: ${summarizeError(err)}. Cleanup was attempted, but the already-started ACP run may still finish in the background.`,
              childSessionKey,
              runId: childRunId,
              ...roleContext,
            });
          }
        }
        return jsonResult(addRoleToFailureResult(result, requestedAgentId));
      }

      let result: Awaited<ReturnType<typeof spawnSubagentDirect>>;
      try {
        result = await spawnSubagentDirect(
          {
            task,
            delegationAssignmentId: guardedRoute?.assignment.assignmentId,
            label: label || undefined,
            agentId: requestedAgentId,
            model: modelOverride,
            thinking: thinkingOverrideRaw,
            runTimeoutSeconds,
            thread,
            mode,
            cleanup,
            sliceRole,
            sliceContinuation,
            sandbox,
            context,
            lightContext,
            expectsCompletionMessage,
            attachments,
            attachMountPath:
              params.attachAs && typeof params.attachAs === "object"
                ? readStringParam(params.attachAs as Record<string, unknown>, "mountPath")
                : undefined,
          },
          {
            agentSessionKey: opts?.agentSessionKey,
            agentChannel: opts?.agentChannel,
            agentAccountId: opts?.agentAccountId,
            agentTo: opts?.agentTo,
            agentThreadId: opts?.agentThreadId,
            agentGroupId: opts?.agentGroupId,
            agentGroupChannel: opts?.agentGroupChannel,
            agentGroupSpace: opts?.agentGroupSpace,
            agentMemberRoleIds: opts?.agentMemberRoleIds,
            requesterAgentIdOverride: opts?.requesterAgentIdOverride,
            workspaceDir: opts?.workspaceDir,
          },
        );
      } catch (error) {
        const message = `${guardedRoute ? "Guarded spawn" : "Subagent spawn"} failed unexpectedly: ${summarizeError(error)}`;
        if (guardedRoute) {
          appendDelegationRouteEvent({
            authorized: guardedRoute,
            kind: "route_rejected",
            reason: message,
          });
        }
        return jsonResult({
          status: "error",
          error: message,
          ...roleContext,
        });
      }

      if (guardedRoute) {
        if (result.status !== "accepted" || !result.childSessionKey) {
          appendDelegationRouteEvent({
            authorized: guardedRoute,
            kind: "route_rejected",
            childSessionKey: result.childSessionKey,
            runId: result.runId,
            reason: result.error ?? "guarded spawn was not accepted",
          });
        } else {
          try {
            appendDelegationRouteEvent({
              authorized: guardedRoute,
              kind: "accepted",
              childSessionKey: result.childSessionKey,
              runId: result.runId,
            });
          } catch (error) {
            appendDelegationRouteEvent({
              authorized: guardedRoute,
              kind: "route_rejected",
              childSessionKey: result.childSessionKey,
              runId: result.runId,
              reason: "protected assignment binding failed after spawn acceptance",
            });
            return jsonResult({
              status: "error",
              error:
                error instanceof Error
                  ? error.message
                  : "Protected assignment binding failed after spawn acceptance.",
              childSessionKey: result.childSessionKey,
              runId: result.runId,
              ...roleContext,
            });
          }
        }
      }

      return jsonResult(addRoleToFailureResult(result, requestedAgentId));
    },
  };
}
