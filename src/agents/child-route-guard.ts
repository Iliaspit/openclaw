import crypto from "node:crypto";
import { recordRejectedChildRouteDeliveryAttempt } from "./child-route-delivery-attempts.js";
import {
  type ChildRouteHealthUnavailableDetails,
  type ChildRouteUnhealthyDetails,
} from "./child-route-health-contract.js";
import {
  assessChildRouteHealth,
  consumeChildRoutePendingSpawn,
  resolveChildTargetKind,
  type ChildRouteHealthContext,
} from "./child-route-health.js";

export type ChildRouteGuardResult =
  | { ok: true }
  | {
      ok: false;
      retryable: boolean;
      code: "child_session_unhealthy" | "child_route_health_unavailable";
      details: ChildRouteUnhealthyDetails | ChildRouteHealthUnavailableDetails;
      message: string;
    };

function stablePayloadHash(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function guardChildRouteForDelivery(params: {
  childSessionKey: string;
  context: ChildRouteHealthContext;
  payloadForHash?: unknown;
  consumePendingSpawn?: boolean;
}): Promise<ChildRouteGuardResult> {
  const childSessionKey = params.childSessionKey.trim();
  const childTargetKind = params.context.childTargetKind ?? resolveChildTargetKind(childSessionKey);
  if (!childTargetKind) {
    return { ok: true };
  }
  const assessment = await assessChildRouteHealth(childSessionKey, {
    ...params.context,
    childTargetKind,
  });
  if (assessment.status === "ok") {
    if (params.consumePendingSpawn && params.context.routeIntent === "initial_spawn") {
      const consumed = await consumeChildRoutePendingSpawn({
        childSessionKey,
        requesterSessionKey:
          params.context.pendingSpawn?.requesterSessionKey ?? params.context.requesterSessionKey,
        idempotencyKey:
          params.context.pendingSpawn?.idempotencyKey ?? params.context.idempotencyKey,
        pendingSpawnId: params.context.pendingSpawn?.pendingSpawnId,
      });
      if (!consumed.ok || !consumed.consumed) {
        return {
          ok: false,
          retryable: true,
          code: "child_route_health_unavailable",
          message: "Child route pending-spawn state could not be consumed.",
          details: {
            kind: "child_route_health_unavailable",
            childSessionKey,
            ...(params.context.requesterSessionKey
              ? { requesterSessionKey: params.context.requesterSessionKey }
              : {}),
            errorKind: "child_pending_spawn_unavailable",
            retryable: true,
            plannerInstruction:
              "Retry after pending-spawn route-health state is available; do not deliver directly to the child.",
          },
        };
      }
    }
    return { ok: true };
  }
  if (assessment.status === "unavailable") {
    return {
      ok: false,
      retryable: assessment.retryable,
      code: "child_route_health_unavailable",
      message: "Child route health is unavailable.",
      details: {
        kind: "child_route_health_unavailable",
        childSessionKey,
        ...(params.context.requesterSessionKey
          ? { requesterSessionKey: params.context.requesterSessionKey }
          : {}),
        errorKind: assessment.errorKind,
        retryable: assessment.retryable,
        plannerInstruction: assessment.plannerInstruction,
      },
    };
  }

  const attempt = await recordRejectedChildRouteDeliveryAttempt({
    requesterSessionKey: params.context.requesterSessionKey,
    requesterGeneration: params.context.requesterGeneration,
    routeIntent: params.context.routeIntent,
    targetMethod: params.context.targetMethod,
    childTargetKind,
    childSessionKey,
    idempotencyKey: params.context.idempotencyKey,
    healthEvidenceEpoch: assessment.healthEvidenceEpoch,
    evidenceEventIds: assessment.evidenceEventIds,
    codes: assessment.codes,
    recommendedAction: assessment.recommendedAction,
    stateTransitionRequired: assessment.stateTransitionRequired,
    plannerInstruction: assessment.plannerInstruction,
    payloadHash: stablePayloadHash(params.payloadForHash),
  });
  if (!attempt.ok) {
    return {
      ok: false,
      retryable: true,
      code: "child_route_health_unavailable",
      message: "Child rejected-attempt state could not be recorded.",
      details: {
        kind: "child_route_health_unavailable",
        childSessionKey,
        ...(params.context.requesterSessionKey
          ? { requesterSessionKey: params.context.requesterSessionKey }
          : {}),
        errorKind: "child_rejected_attempt_unavailable",
        retryable: true,
        plannerInstruction:
          "Retry after rejected-attempt storage is available; do not deliver directly to the child.",
      },
    };
  }

  return {
    ok: false,
    retryable: false,
    code: "child_session_unhealthy",
    message: "Child session is unhealthy for follow-up work.",
    details: {
      kind: "child_route_unhealthy",
      childSessionKey,
      ...(params.context.requesterSessionKey
        ? { requesterSessionKey: params.context.requesterSessionKey }
        : {}),
      deliveryAttemptId: attempt.attempt.deliveryAttemptId,
      codes: assessment.codes,
      recommendedAction: assessment.recommendedAction,
      stateTransitionRequired: assessment.stateTransitionRequired,
      plannerInstruction: assessment.plannerInstruction,
    },
  };
}
