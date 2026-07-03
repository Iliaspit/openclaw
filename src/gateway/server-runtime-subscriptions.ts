import { onAgentEvent } from "../infra/agent-events.js";
import { onHeartbeatEvent } from "../infra/heartbeat-events.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { GATEWAY_CLIENT_CAPS } from "./protocol/client-info.js";
import { selectConnIdsWithClientCap } from "./server-broadcast.js";
import {
  createAgentEventHandler,
  type ChatRunState,
  type SessionEventSubscriberRegistry,
  type SessionMessageSubscriberRegistry,
  type ToolEventRecipientRegistry,
} from "./server-chat.js";
import {
  createLifecycleEventBroadcastHandler,
  createTranscriptUpdateBroadcastHandler,
} from "./server-session-events.js";
import type { GatewayWsClient } from "./server/ws-types.js";

export function startGatewayEventSubscriptions(params: {
  minimalTestGateway: boolean;
  clients: ReadonlySet<GatewayWsClient>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
  toolEventRecipients: ToolEventRecipientRegistry;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  sessionMessageSubscribers: SessionMessageSubscriberRegistry;
  chatAbortControllers: Map<string, unknown>;
}) {
  const selectOrchestrationConnIds = (connIds?: ReadonlySet<string>) =>
    selectConnIdsWithClientCap({
      clients: params.clients,
      connIds,
      cap: GATEWAY_CLIENT_CAPS.ORCHESTRATION_EVENTS,
    });
  const agentUnsub = params.minimalTestGateway
    ? null
    : onAgentEvent(
        createAgentEventHandler({
          broadcast: params.broadcast,
          broadcastToConnIds: params.broadcastToConnIds,
          nodeSendToSession: params.nodeSendToSession,
          agentRunSeq: params.agentRunSeq,
          chatRunState: params.chatRunState,
          resolveSessionKeyForRun: params.resolveSessionKeyForRun,
          clearAgentRunContext: params.clearAgentRunContext,
          toolEventRecipients: params.toolEventRecipients,
          sessionEventSubscribers: params.sessionEventSubscribers,
          selectOrchestrationConnIds,
          isChatSendRunActive: (runId) => params.chatAbortControllers.has(runId),
        }),
      );

  const heartbeatUnsub = params.minimalTestGateway
    ? null
    : onHeartbeatEvent((evt) => {
        params.broadcast("heartbeat", evt, { dropIfSlow: true });
      });

  const transcriptUnsub = params.minimalTestGateway
    ? null
    : onSessionTranscriptUpdate(
        createTranscriptUpdateBroadcastHandler({
          broadcastToConnIds: params.broadcastToConnIds,
          sessionEventSubscribers: params.sessionEventSubscribers,
          sessionMessageSubscribers: params.sessionMessageSubscribers,
          selectOrchestrationConnIds,
        }),
      );

  const lifecycleUnsub = params.minimalTestGateway
    ? null
    : onSessionLifecycleEvent(
        createLifecycleEventBroadcastHandler({
          broadcastToConnIds: params.broadcastToConnIds,
          sessionEventSubscribers: params.sessionEventSubscribers,
        }),
      );

  return {
    agentUnsub,
    heartbeatUnsub,
    transcriptUnsub,
    lifecycleUnsub,
  };
}
