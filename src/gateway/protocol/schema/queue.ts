import { Type } from "@sinclair/typebox";

export const QueueHealthParamsSchema = Type.Object(
  {
    lane: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);

const NullableNonNegativeInteger = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);

export const QueueRuntimeIssueSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1, maxLength: 512 }),
    code: Type.Union([
      Type.Literal("context_overflow"),
      Type.Literal("agent_lifecycle_error"),
      Type.Literal("agent_lifecycle_blocked"),
      Type.Literal("agent_lifecycle_abandoned"),
    ]),
    severity: Type.Union([Type.Literal("warning"), Type.Literal("error")]),
    message: Type.String({ minLength: 1, maxLength: 512 }),
    observedAt: Type.Integer({ minimum: 0 }),
    lastUpdatedAt: Type.Integer({ minimum: 0 }),
    count: Type.Integer({ minimum: 1 }),
    sessionKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    lane: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    livenessState: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
);

export const QueueLaneSnapshotSchema = Type.Object(
  {
    lane: Type.String({ minLength: 1, maxLength: 512 }),
    health: Type.Union([
      Type.Literal("idle"),
      Type.Literal("running"),
      Type.Literal("waiting"),
      Type.Literal("degraded"),
      Type.Literal("blocked"),
      Type.Literal("draining"),
    ]),
    queued: Type.Integer({ minimum: 0 }),
    active: Type.Integer({ minimum: 0 }),
    depth: Type.Integer({ minimum: 0 }),
    maxConcurrent: Type.Integer({ minimum: 1 }),
    isOverloaded: Type.Optional(Type.Boolean()),
    draining: Type.Boolean(),
    oldestQueuedAt: NullableNonNegativeInteger,
    oldestQueuedMs: NullableNonNegativeInteger,
    oldestActiveStartedAt: NullableNonNegativeInteger,
    oldestActiveMs: NullableNonNegativeInteger,
    lastWaitMs: NullableNonNegativeInteger,
    lastDequeuedAt: NullableNonNegativeInteger,
    lastTaskDurationMs: NullableNonNegativeInteger,
    lastCompletedAt: NullableNonNegativeInteger,
    lastErrorAt: NullableNonNegativeInteger,
    lastClearedAt: NullableNonNegativeInteger,
    runtimeIssues: Type.Array(QueueRuntimeIssueSchema, { maxItems: 100 }),
  },
  { additionalProperties: false },
);

export const QueueHealthResultSchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
    gatewayDraining: Type.Boolean(),
    totalQueued: Type.Integer({ minimum: 0 }),
    totalActive: Type.Integer({ minimum: 0 }),
    totalDepth: Type.Integer({ minimum: 0 }),
    totalRuntimeIssues: Type.Integer({ minimum: 0 }),
    runtimeIssues: Type.Array(QueueRuntimeIssueSchema, { maxItems: 100 }),
    lanes: Type.Array(QueueLaneSnapshotSchema, { maxItems: 1000 }),
  },
  { additionalProperties: false },
);
