import crypto from "node:crypto";
import { Type } from "typebox";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { guardChildRouteForDelivery } from "../child-route-guard.js";
import { resolveChildRouteProviderContextFromSession } from "../child-route-provider-context.js";
import {
  appendDelegationRouteEvent,
  authorizeDelegationRoute,
  bindDelegationRoute,
  issueDelegationGatewayDispatch,
  type AuthorizedDelegationRoute,
} from "../delegation/runtime.js";
import { optionalStringEnum } from "../schema/typebox.js";
import {
  DEFAULT_RECENT_MINUTES,
  compactControlledSubagentSession,
  killAllControlledSubagentRuns,
  killControlledSubagentRun,
  listControlledSubagentRuns,
  MAX_RECENT_MINUTES,
  MAX_STEER_MESSAGE_CHARS,
  resolveControlledSubagentTarget,
  resolveSessionEntryForKey,
  resolveSubagentController,
  steerControlledSubagentRun,
} from "../subagent-control.js";
import {
  buildSubagentList,
  createPendingDescendantCounter,
  isActiveSubagentRun,
} from "../subagent-list.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const SUBAGENT_ACTIONS = ["list", "kill", "steer", "compact"] as const;
type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];
const SELF_COMPACTION_TARGETS = new Set(["self", "current", "caller"]);

const SubagentsToolSchema = Type.Object({
  action: optionalStringEnum(SUBAGENT_ACTIONS),
  target: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  delegationToken: Type.Optional(
    Type.String({
      minLength: 1,
      description: "One-use runtime token issued by delegation_guard for guarded steer routes.",
    }),
  ),
  recentMinutes: Type.Optional(Type.Number({ minimum: 1 })),
});

export function createSubagentsTool(opts?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
  effectiveThinking?: string;
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Subagents",
    name: "subagents",
    description:
      "List, kill, steer, or compact spawned sub-agents for this requester session, including restarting finished child sessions with tracked completion. Use this for sub-agent orchestration.",
    parameters: SubagentsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = (readStringParam(params, "action") ?? "list") as SubagentAction;
      const cfg = opts?.config ?? loadConfig();
      const controller = resolveSubagentController({
        cfg,
        agentSessionKey: opts?.agentSessionKey,
      });
      const runs = listControlledSubagentRuns(controller.controllerSessionKey);
      const recentMinutesRaw = readNumberParam(params, "recentMinutes");
      const recentMinutes = recentMinutesRaw
        ? Math.max(1, Math.min(MAX_RECENT_MINUTES, Math.floor(recentMinutesRaw)))
        : DEFAULT_RECENT_MINUTES;
      const pendingDescendantCount = createPendingDescendantCounter();
      const isActive = (entry: (typeof runs)[number]) =>
        isActiveSubagentRun(entry, pendingDescendantCount);

      if (action === "list") {
        const list = buildSubagentList({
          cfg,
          runs,
          recentMinutes,
        });
        return jsonResult({
          status: "ok",
          action: "list",
          requesterSessionKey: controller.controllerSessionKey,
          callerSessionKey: controller.callerSessionKey,
          callerIsSubagent: controller.callerIsSubagent,
          total: list.total,
          active: list.active.map(({ line: _line, ...view }) => view),
          recent: list.recent.map(({ line: _line, ...view }) => view),
          text: list.text,
        });
      }

      if (action === "kill") {
        const target = readStringParam(params, "target", { required: true });
        if (target === "all" || target === "*") {
          const result = await killAllControlledSubagentRuns({
            cfg,
            controller,
            runs,
          });
          if (result.status === "forbidden") {
            return jsonResult({
              status: "forbidden",
              action: "kill",
              target: "all",
              error: result.error,
            });
          }
          return jsonResult({
            status: "ok",
            action: "kill",
            target: "all",
            killed: result.killed,
            labels: result.labels,
            text:
              result.killed > 0
                ? `killed ${result.killed} subagent${result.killed === 1 ? "" : "s"}.`
                : "no running subagents to kill.",
          });
        }
        const resolved = resolveControlledSubagentTarget(runs, target, {
          recentMinutes,
          isActive,
        });
        if (!resolved.entry) {
          return jsonResult({
            status: "error",
            action: "kill",
            target,
            error: resolved.error ?? "Unknown subagent target.",
          });
        }
        const result = await killControlledSubagentRun({
          cfg,
          controller,
          entry: resolved.entry,
        });
        return jsonResult({
          status: result.status,
          action: "kill",
          target,
          runId: result.runId,
          sessionKey: result.sessionKey,
          label: result.label,
          cascadeKilled: "cascadeKilled" in result ? result.cascadeKilled : undefined,
          cascadeLabels: "cascadeLabels" in result ? result.cascadeLabels : undefined,
          error: "error" in result ? result.error : undefined,
          text: result.text,
        });
      }

      if (action === "compact") {
        const target = readStringParam(params, "target", { required: true });
        const selfTarget = SELF_COMPACTION_TARGETS.has(target.toLowerCase());
        if (selfTarget) {
          const result = await compactControlledSubagentSession({
            cfg,
            controller,
            target: {
              kind: "self",
              sessionKey: controller.callerSessionKey,
            },
          });
          return jsonResult({
            status: result.status,
            action: "compact",
            target,
            sessionKey: result.sessionKey,
            key: result.key,
            compacted: result.compacted,
            reason: result.reason,
            checkpointId: result.checkpointId,
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
            routeHealthRepairStatus: result.routeHealthRepairStatus,
            text: result.text,
          });
        }

        const resolved = resolveControlledSubagentTarget(runs, target, {
          recentMinutes,
          isActive,
        });
        if (!resolved.entry) {
          return jsonResult({
            status: "error",
            action: "compact",
            target,
            reason: resolved.error ?? "Unknown subagent target.",
          });
        }
        const result = await compactControlledSubagentSession({
          cfg,
          controller,
          target: {
            kind: "child",
            entry: resolved.entry,
          },
        });
        return jsonResult({
          status: result.status,
          action: "compact",
          target,
          sessionKey: result.sessionKey,
          key: result.key,
          compacted: result.compacted,
          reason: result.reason,
          checkpointId: result.checkpointId,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          routeHealthRepairStatus: result.routeHealthRepairStatus,
          text: result.text,
        });
      }

      if (action === "steer") {
        const target = readStringParam(params, "target", { required: true });
        const message = readStringParam(params, "message", { required: true });
        const delegationToken = readStringParam(params, "delegationToken");
        if (message.length > MAX_STEER_MESSAGE_CHARS) {
          return jsonResult({
            status: "error",
            action: "steer",
            target,
            error: `Message too long (${message.length} chars, max ${MAX_STEER_MESSAGE_CHARS}).`,
          });
        }
        const resolved = resolveControlledSubagentTarget(runs, target, {
          recentMinutes,
          isActive,
        });
        if (!resolved.entry) {
          return jsonResult({
            status: "error",
            action: "steer",
            target,
            error: resolved.error ?? "Unknown subagent target.",
          });
        }
        const targetSession = resolveSessionEntryForKey({
          cfg,
          key: resolved.entry.childSessionKey,
          cache: new Map(),
        });
        const targetProvider = resolveChildRouteProviderContextFromSession({
          cfg,
          sessionKey: resolved.entry.childSessionKey,
          entry: targetSession.entry,
          requesterSessionKey: controller.controllerSessionKey,
        });
        const targetModel =
          targetProvider.providerId && targetProvider.modelId
            ? `${targetProvider.providerId}/${targetProvider.modelId}`
            : undefined;
        const idempotencyKey = crypto.randomUUID();
        let guardedRoute: AuthorizedDelegationRoute | undefined;
        try {
          guardedRoute = authorizeDelegationRoute({
            config: cfg,
            agentSessionKey: controller.callerSessionKey,
            requesterAgentIdOverride: opts?.requesterAgentIdOverride,
            effectiveThinking: opts?.effectiveThinking,
            targetAgentId: resolveAgentIdFromSessionKey(resolved.entry.childSessionKey),
            targetThinking: targetSession.entry?.thinkingLevel,
            targetModel,
            targetSessionKey: resolved.entry.childSessionKey,
            delegationToken,
            idempotencyKey,
            routeKind: "steer",
          });
        } catch (error) {
          return jsonResult({
            status: "forbidden",
            action: "steer",
            target,
            error: error instanceof Error ? error.message : "Guarded steer authorization failed.",
          });
        }
        let routeGuard: Awaited<ReturnType<typeof guardChildRouteForDelivery>>;
        try {
          routeGuard = await guardChildRouteForDelivery({
            childSessionKey: resolved.entry.childSessionKey,
            context: {
              routeIntent: "followup_reuse",
              targetMethod: "subagents.steer",
              requesterSessionKey: controller.controllerSessionKey,
              childTargetKind: "subagent",
              registryRecord: resolved.entry,
              provider: targetProvider,
            },
            payloadForHash: {
              method: "subagents.steer",
              message: message.trim(),
            },
          });
        } catch (error) {
          appendDelegationRouteEvent({
            authorized: guardedRoute,
            kind: "route_rejected",
            childSessionKey: resolved.entry.childSessionKey,
            runId: resolved.entry.runId,
            reason: `child route guard failed before dispatch: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          return jsonResult({
            status: "error",
            action: "steer",
            target,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!routeGuard.ok) {
          appendDelegationRouteEvent({
            authorized: guardedRoute,
            kind: "route_rejected",
            childSessionKey: resolved.entry.childSessionKey,
            runId: resolved.entry.runId,
            reason: routeGuard.code,
          });
          return jsonResult({
            ok: false,
            code: routeGuard.code,
            details: routeGuard.details,
          });
        }
        let delegationGatewayDispatch: string | undefined;
        try {
          delegationGatewayDispatch = issueDelegationGatewayDispatch({
            authorized: guardedRoute,
            targetSessionKey: resolved.entry.childSessionKey,
            idempotencyKey,
          });
        } catch (error) {
          appendDelegationRouteEvent({
            authorized: guardedRoute,
            kind: "route_rejected",
            childSessionKey: resolved.entry.childSessionKey,
            runId: resolved.entry.runId,
            reason: "gateway dispatch capability issuance failed",
          });
          return jsonResult({
            status: "forbidden",
            action: "steer",
            target,
            error:
              error instanceof Error
                ? error.message
                : "Guarded Gateway dispatch authorization failed.",
          });
        }
        let result: Awaited<ReturnType<typeof steerControlledSubagentRun>>;
        try {
          result = await steerControlledSubagentRun({
            cfg,
            controller,
            entry: resolved.entry,
            message,
            delegationAssignmentId: guardedRoute?.assignment.assignmentId,
            delegationGatewayDispatch,
            idempotencyKey,
          });
        } catch (error) {
          appendDelegationRouteEvent({
            authorized: guardedRoute,
            kind: "route_rejected",
            childSessionKey: resolved.entry.childSessionKey,
            runId: resolved.entry.runId,
            reason: `guarded steer dispatch failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          return jsonResult({
            status: "error",
            action: "steer",
            target,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (result.status === "accepted") {
          bindDelegationRoute({
            authorized: guardedRoute,
            childSessionKey: resolved.entry.childSessionKey,
            runId: result.runId,
          });
          appendDelegationRouteEvent({
            authorized: guardedRoute,
            kind: "accepted",
            childSessionKey: resolved.entry.childSessionKey,
            runId: result.runId,
          });
        } else {
          appendDelegationRouteEvent({
            authorized: guardedRoute,
            kind: "route_rejected",
            childSessionKey: resolved.entry.childSessionKey,
            runId: result.runId,
            reason: "error" in result ? result.error : result.text,
          });
        }
        return jsonResult({
          status: result.status,
          action: "steer",
          target,
          runId: result.runId,
          sessionKey: result.sessionKey,
          sessionId: result.sessionId,
          mode: "mode" in result ? result.mode : undefined,
          label: "label" in result ? result.label : undefined,
          error: "error" in result ? result.error : undefined,
          text: result.text,
        });
      }

      return jsonResult({
        status: "error",
        error: "Unsupported action.",
      });
    },
  };
}
