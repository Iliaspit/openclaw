import { Type, type Static } from "@sinclair/typebox";

export const CHILD_ROUTE_HEALTH_CODES = [
  "child_conversation_expired",
  "auth_profile_session_expired",
  "context_overflow",
  "agent_lifecycle_blocked",
  "agent_lifecycle_abandoned",
  "agent_lifecycle_error",
  "edit_failure_threshold",
] as const;

export type ChildRouteHealthCode = (typeof CHILD_ROUTE_HEALTH_CODES)[number];

export const CHILD_ROUTE_RECOMMENDED_ACTIONS = [
  "spawn_fresh",
  "reauth",
  "fallback_profile",
  "stop",
] as const;

export type ChildRouteRecommendedAction = (typeof CHILD_ROUTE_RECOMMENDED_ACTIONS)[number];

export const CHILD_ROUTE_INTENTS = [
  "initial_spawn",
  "followup_reuse",
  "reactivation",
  "a2a_step",
  "completion_receipt",
  "descendant_wake",
  "repair_control",
] as const;

export type ChildRouteIntent = (typeof CHILD_ROUTE_INTENTS)[number];

export const CHILD_TARGET_KINDS = ["subagent", "acp"] as const;
export type ChildTargetKind = (typeof CHILD_TARGET_KINDS)[number];

export const CHILD_ROUTE_HEADROOM_ESTIMATE_SOURCES = [
  "actual_request",
  "preflight_estimate",
  "unknown",
] as const;

export type ChildRouteHeadroomEstimateSource =
  (typeof CHILD_ROUTE_HEADROOM_ESTIMATE_SOURCES)[number];

export const CHILD_ROUTE_COMPACTION_STATUSES = [
  "none",
  "pending",
  "succeeded",
  "failed",
  "unknown",
] as const;

export type ChildRouteCompactionStatus = (typeof CHILD_ROUTE_COMPACTION_STATUSES)[number];

export const ChildRouteHealthCodeSchema = Type.Union(
  CHILD_ROUTE_HEALTH_CODES.map((code) => Type.Literal(code)),
);

export const ChildRouteRecommendedActionSchema = Type.Union(
  CHILD_ROUTE_RECOMMENDED_ACTIONS.map((action) => Type.Literal(action)),
);

export const ChildRouteIntentSchema = Type.Union(
  CHILD_ROUTE_INTENTS.map((intent) => Type.Literal(intent)),
);

export const ChildTargetKindSchema = Type.Union(
  CHILD_TARGET_KINDS.map((kind) => Type.Literal(kind)),
);

export const ChildRouteUnhealthyDetailsSchema = Type.Object(
  {
    kind: Type.Literal("child_route_unhealthy"),
    childSessionKey: Type.String({ minLength: 1, maxLength: 512 }),
    requesterSessionKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    deliveryAttemptId: Type.String({ minLength: 1, maxLength: 128 }),
    codes: Type.Array(ChildRouteHealthCodeSchema, { minItems: 1, maxItems: 16 }),
    recommendedAction: ChildRouteRecommendedActionSchema,
    stateTransitionRequired: Type.Boolean(),
    plannerInstruction: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);

export type ChildRouteUnhealthyDetails = Static<typeof ChildRouteUnhealthyDetailsSchema>;

export const ChildRouteHealthUnavailableDetailsSchema = Type.Object(
  {
    kind: Type.Literal("child_route_health_unavailable"),
    childSessionKey: Type.String({ minLength: 1, maxLength: 512 }),
    requesterSessionKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    deliveryAttemptId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    errorKind: Type.String({ minLength: 1, maxLength: 128 }),
    retryable: Type.Boolean(),
    plannerInstruction: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);

export type ChildRouteHealthUnavailableDetails = Static<
  typeof ChildRouteHealthUnavailableDetailsSchema
>;
