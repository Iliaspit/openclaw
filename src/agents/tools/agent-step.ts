import crypto from "node:crypto";
import { loadConfig } from "../../config/config.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import { callGateway } from "../../gateway/call.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { guardChildRouteForDelivery } from "../child-route-guard.js";
import { resolveChildTargetKind } from "../child-route-health.js";
import { resolveChildRouteProviderContextFromSession } from "../child-route-provider-context.js";
import { AGENT_LANE_NESTED } from "../lanes.js";
import { waitForAgentRunAndReadUpdatedAssistantReply } from "../run-wait.js";
import { getLatestSubagentRunByChildSessionKey } from "../subagent-registry-read.js";

export { readLatestAssistantReply } from "../run-wait.js";

type GatewayCaller = typeof callGateway;

const defaultAgentStepDeps = {
  callGateway,
};

let agentStepDeps: {
  callGateway: GatewayCaller;
} = defaultAgentStepDeps;

function resolveAgentStepProviderContext(params: {
  sessionKey: string;
  requesterSessionKey?: string;
}) {
  const cfg = loadConfig();
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const entry = loadSessionStore(storePath, { skipCache: true })[params.sessionKey];
  return resolveChildRouteProviderContextFromSession({
    cfg,
    sessionKey: params.sessionKey,
    entry,
    requesterSessionKey: params.requesterSessionKey,
  });
}

export async function runAgentStep(params: {
  sessionKey: string;
  message: string;
  extraSystemPrompt: string;
  timeoutMs: number;
  channel?: string;
  lane?: string;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
}): Promise<string | undefined> {
  const childTargetKind = resolveChildTargetKind(params.sessionKey);
  const stepIdem = crypto.randomUUID();
  if (childTargetKind) {
    const routeGuard = await guardChildRouteForDelivery({
      childSessionKey: params.sessionKey,
      context: {
        routeIntent: "a2a_step",
        targetMethod: "agent_step",
        idempotencyKey: stepIdem,
        requesterSessionKey: params.sourceSessionKey,
        childTargetKind,
        registryRecord: getLatestSubagentRunByChildSessionKey(params.sessionKey),
        provider: resolveAgentStepProviderContext({
          sessionKey: params.sessionKey,
          requesterSessionKey: params.sourceSessionKey,
        }),
      },
      payloadForHash: {
        method: "agent_step",
        sourceTool: params.sourceTool ?? "sessions_send",
        message: params.message.trim(),
      },
    });
    if (!routeGuard.ok) {
      return undefined;
    }
  }
  const response = await agentStepDeps.callGateway({
    method: "agent",
    params: {
      message: params.message,
      sessionKey: params.sessionKey,
      idempotencyKey: stepIdem,
      deliver: false,
      channel: params.channel ?? INTERNAL_MESSAGE_CHANNEL,
      lane: params.lane ?? AGENT_LANE_NESTED,
      extraSystemPrompt: params.extraSystemPrompt,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel,
        sourceTool: params.sourceTool ?? "sessions_send",
      },
    },
    timeoutMs: 10_000,
  });

  const stepRunId = typeof response?.runId === "string" && response.runId ? response.runId : "";
  const resolvedRunId = stepRunId || stepIdem;
  const result = await waitForAgentRunAndReadUpdatedAssistantReply({
    runId: resolvedRunId,
    sessionKey: params.sessionKey,
    timeoutMs: Math.min(params.timeoutMs, 60_000),
  });
  if (result.status !== "ok") {
    return undefined;
  }
  return result.replyText;
}

export const __testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    agentStepDeps = overrides
      ? {
          ...defaultAgentStepDeps,
          ...overrides,
        }
      : defaultAgentStepDeps;
  },
};
