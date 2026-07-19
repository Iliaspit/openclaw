import path from "node:path";
import { z } from "zod";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";
import { TranscribeAudioSchema } from "./zod-schema.core.js";

const DelegationGuardSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(["audit", "enforce"]),
    controllers: z
      .array(
        z
          .object({
            agentId: z.string().trim().min(1),
            requiredThinking: z.literal("xhigh"),
          })
          .strict(),
      )
      .min(1),
    workers: z
      .array(
        z
          .object({
            agentId: z.string().trim().min(1),
            role: z.enum(["helper", "implementer", "tester", "reviewer", "qa"]),
            requiredThinking: z.enum(["medium", "high", "xhigh"]),
            workspaceAccess: z.enum(["ro", "rw"]),
          })
          .strict(),
      )
      .min(5),
    validator: z
      .object({
        id: z.string().trim().min(1),
        version: z.string().trim().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        entrypoint: z
          .string()
          .trim()
          .min(1)
          .refine((value) => path.isAbsolute(value), {
            message: "Delegation validator entrypoint must be absolute.",
          }),
        maxOutputBytes: z
          .number()
          .int()
          .min(1024)
          .max(1024 * 1024),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const controllerIds = new Set<string>();
    for (const [index, controller] of value.controllers.entries()) {
      const normalizedId = controller.agentId.toLowerCase();
      if (controller.agentId !== normalizedId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["controllers", index, "agentId"],
          message: "Delegation controller agent ids must already be normalized lowercase ids.",
        });
      }
      if (controllerIds.has(normalizedId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["controllers", index, "agentId"],
          message: "Delegation controller agent ids must be unique.",
        });
      }
      controllerIds.add(normalizedId);
    }
    const workerIds = new Set<string>();
    const workerRoles = new Set<string>();
    for (const [index, worker] of value.workers.entries()) {
      const normalizedId = worker.agentId.toLowerCase();
      if (worker.agentId !== normalizedId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workers", index, "agentId"],
          message: "Delegation worker agent ids must already be normalized lowercase ids.",
        });
      }
      if (workerIds.has(normalizedId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workers", index, "agentId"],
          message: "Delegation worker agent ids must be unique.",
        });
      }
      if (workerRoles.has(worker.role)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workers", index, "role"],
          message: "Each guarded worker role must map to exactly one agent.",
        });
      }
      if (controllerIds.has(normalizedId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workers", index, "agentId"],
          message: "An agent cannot be both a delegation controller and worker.",
        });
      }
      workerIds.add(normalizedId);
      workerRoles.add(worker.role);
    }
    for (const role of ["helper", "implementer", "tester", "reviewer", "qa"] as const) {
      if (!workerRoles.has(role)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["workers"],
          message: `Delegation guard requires exactly one ${role} worker.`,
        });
      }
    }
  });

export const AgentsSchema = z
  .object({
    defaults: z.lazy(() => AgentDefaultsSchema).optional(),
    list: z.array(AgentEntrySchema).optional(),
    delegationGuard: DelegationGuardSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const guard = value.delegationGuard;
    if (!guard?.enabled) {
      return;
    }
    const agents = new Map((value.list ?? []).map((agent) => [agent.id.toLowerCase(), agent]));
    const workerIds = guard.workers.map((worker) => worker.agentId).toSorted();
    const addAgentIssue = (agentId: string, field: string, message: string) => {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["list", field],
        message: `Guarded agent ${agentId} ${message}`,
      });
    };
    for (const controller of guard.controllers) {
      const agent = agents.get(controller.agentId);
      if (!agent) {
        addAgentIssue(controller.agentId, "id", "must exist in agents.list.");
        continue;
      }
      if (agent.thinkingDefault !== controller.requiredThinking) {
        addAgentIssue(controller.agentId, "thinkingDefault", "must use exact xhigh thinking.");
      }
      if (agent.runtime?.type === "acp") {
        addAgentIssue(controller.agentId, "runtime", "must use the embedded runtime.");
      }
      if (
        agent.sandbox?.mode !== "all" ||
        agent.sandbox.backend !== "docker" ||
        agent.sandbox.scope !== "session" ||
        agent.sandbox.workspaceAccess !== "ro"
      ) {
        addAgentIssue(
          controller.agentId,
          "sandbox",
          "must use a per-session Docker sandbox with read-only workspace access.",
        );
      }
      const allowed = (agent.subagents?.allowAgents ?? []).map((id) => id.toLowerCase()).toSorted();
      if (JSON.stringify(allowed) !== JSON.stringify(workerIds)) {
        addAgentIssue(
          controller.agentId,
          "subagents.allowAgents",
          "must allow exactly the configured guarded workers.",
        );
      }
    }
    for (const worker of guard.workers) {
      const agent = agents.get(worker.agentId);
      if (!agent) {
        addAgentIssue(worker.agentId, "id", "must exist in agents.list.");
        continue;
      }
      if (agent.thinkingDefault !== worker.requiredThinking) {
        addAgentIssue(
          worker.agentId,
          "thinkingDefault",
          `must use exact ${worker.requiredThinking} thinking.`,
        );
      }
      if (agent.runtime?.type === "acp") {
        addAgentIssue(worker.agentId, "runtime", "must use the embedded runtime.");
      }
      if (
        agent.sandbox?.mode !== "all" ||
        agent.sandbox.backend !== "docker" ||
        agent.sandbox.scope !== "session" ||
        agent.sandbox.workspaceAccess !== worker.workspaceAccess
      ) {
        addAgentIssue(
          worker.agentId,
          "sandbox",
          `must use a per-session Docker sandbox with ${worker.workspaceAccess} workspace access.`,
        );
      }
      const primary = typeof agent.model === "string" ? agent.model : agent.model?.primary;
      const fallbacks = typeof agent.model === "string" ? [] : (agent.model?.fallbacks ?? []);
      if (!primary?.includes("/") || fallbacks.length > 0) {
        addAgentIssue(
          worker.agentId,
          "model",
          "must configure one explicit provider/model primary with no fallbacks.",
        );
      }
    }
  })
  .optional();

const BindingMatchSchema = z
  .object({
    channel: z.string(),
    accountId: z.string().optional(),
    peer: z
      .object({
        kind: z.union([
          z.literal("direct"),
          z.literal("group"),
          z.literal("channel"),
          /** @deprecated Use `direct` instead. Kept for backward compatibility. */
          z.literal("dm"),
        ]),
        id: z.string(),
      })
      .strict()
      .optional(),
    guildId: z.string().optional(),
    teamId: z.string().optional(),
    roles: z.array(z.string()).optional(),
  })
  .strict();

const RouteBindingSchema = z
  .object({
    type: z.literal("route").optional(),
    agentId: z.string(),
    comment: z.string().optional(),
    match: BindingMatchSchema,
  })
  .strict();

const AcpBindingSchema = z
  .object({
    type: z.literal("acp"),
    agentId: z.string(),
    comment: z.string().optional(),
    match: BindingMatchSchema,
    acp: z
      .object({
        mode: z.enum(["persistent", "oneshot"]).optional(),
        label: z.string().optional(),
        cwd: z.string().optional(),
        backend: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const peerId = normalizeOptionalString(value.match.peer?.id) ?? "";
    if (!peerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["match", "peer"],
        message: "ACP bindings require match.peer.id to target a concrete conversation.",
      });
      return;
    }
  });

export const BindingsSchema = z.array(z.union([RouteBindingSchema, AcpBindingSchema])).optional();

export const BroadcastStrategySchema = z.enum(["parallel", "sequential"]);

export const BroadcastSchema = z
  .object({
    strategy: BroadcastStrategySchema.optional(),
  })
  .catchall(z.array(z.string()))
  .optional();

export const AudioSchema = z
  .object({
    transcription: TranscribeAudioSchema,
  })
  .strict()
  .optional();
