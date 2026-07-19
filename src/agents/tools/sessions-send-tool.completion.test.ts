import { describe, expect, it } from "vitest";
import {
  buildFreshChildRerouteResponse,
  resolveSessionsSendCompletionMetadata,
} from "./sessions-send-tool.js";

type BuildFreshChildRerouteResponseParams = Parameters<typeof buildFreshChildRerouteResponse>[0];

const unusedGateway: BuildFreshChildRerouteResponseParams["callGateway"] = async <T>() => ({}) as T;

function buildMarker(caseId: string): BuildFreshChildRerouteResponseParams["marker"] {
  return {
    status: "accepted",
    key: `reroute-${caseId}`,
    createdAt: 1,
    runId: `run-${caseId}`,
    childSessionKey: `agent:main:subagent:${caseId}`,
    reroute: {
      status: "not_reroutable",
      action: "stop",
      plannerInstruction: "test marker",
    },
  };
}

const terminalMetadata = {
  startedAt: 100,
  endedAt: 200,
  rawCompletionStopReason: "max_tokens",
} as const;

describe("sessions_send completion metadata", () => {
  it("makes model truncation and terminal timing explicit to the parent", () => {
    expect(
      resolveSessionsSendCompletionMetadata({
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        rawCompletionStopReason: "max_tokens",
      }),
    ).toEqual({
      startedAt: 100,
      endedAt: 200,
      rawCompletionStopReason: "max_tokens",
      modelCompletion: "truncated",
    });
  });

  it("preserves metadata on a successful fresh-child response", async () => {
    const marker = buildMarker("success");
    const result = await buildFreshChildRerouteResponse({
      marker,
      timeoutSeconds: 1,
      timeoutMs: 1_000,
      callGateway: unusedGateway,
      waitForResult: async () => ({
        status: "ok",
        replyText: "fresh child reply",
        ...terminalMetadata,
      }),
      ensureResultReceipt: () => ({ ok: true }),
    });

    expect(result).toEqual({
      runId: marker.runId,
      status: "ok",
      reply: "fresh child reply",
      ...terminalMetadata,
      modelCompletion: "truncated",
      sessionKey: marker.childSessionKey,
      delivery: { status: "tracked", mode: "completion_event" },
      reroute: marker.reroute,
    });
  });

  it("preserves metadata on a fresh-child wait timeout", async () => {
    const marker = buildMarker("timeout");
    const result = await buildFreshChildRerouteResponse({
      marker,
      timeoutSeconds: 1,
      timeoutMs: 1_000,
      callGateway: unusedGateway,
      waitForResult: async () => ({
        status: "timeout",
        error: "wait timed out",
        ...terminalMetadata,
      }),
    });

    expect(result).toEqual({
      runId: marker.runId,
      status: "timeout",
      error: "wait timed out",
      ...terminalMetadata,
      modelCompletion: "truncated",
      sessionKey: marker.childSessionKey,
      delivery: { status: "tracked", mode: "completion_event" },
      reroute: marker.reroute,
    });
  });

  it("preserves metadata on a fresh-child agent error", async () => {
    const marker = buildMarker("agent-error");
    const result = await buildFreshChildRerouteResponse({
      marker,
      timeoutSeconds: 1,
      timeoutMs: 1_000,
      callGateway: unusedGateway,
      waitForResult: async () => ({
        status: "error",
        error: "agent failed",
        ...terminalMetadata,
      }),
    });

    expect(result).toEqual({
      runId: marker.runId,
      status: "error",
      error: "agent failed",
      ...terminalMetadata,
      modelCompletion: "truncated",
      sessionKey: marker.childSessionKey,
      reroute: marker.reroute,
    });
  });

  it("preserves metadata when post-wait receipt persistence fails", async () => {
    const marker = buildMarker("receipt-error");
    const result = await buildFreshChildRerouteResponse({
      marker,
      timeoutSeconds: 1,
      timeoutMs: 1_000,
      callGateway: unusedGateway,
      waitForResult: async () => ({
        status: "ok",
        replyText: "fresh child reply",
        ...terminalMetadata,
      }),
      ensureResultReceipt: () => ({ ok: false, error: "receipt persistence failed" }),
    });

    expect(result).toEqual({
      runId: marker.runId,
      status: "error",
      error: "receipt persistence failed",
      ...terminalMetadata,
      modelCompletion: "truncated",
      sessionKey: marker.childSessionKey,
      reroute: marker.reroute,
    });
  });
});
