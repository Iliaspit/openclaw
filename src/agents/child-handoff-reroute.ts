import { redactSensitiveText } from "../logging/redact.js";
import type {
  ChildRouteHealthUnavailableDetails,
  ChildRouteRecommendedAction,
  ChildRouteUnhealthyDetails,
} from "./child-route-health-contract.js";

const PACKET_VERSION = 1 as const;
const MAX_PACKET_BYTES = 32 * 1024;
const MAX_SEMANTIC_BYTES = 24 * 1024;
const MAX_ENVELOPE_BYTES = 8 * 1024;
const MAX_FILE_REFERENCES = 30;
const MAX_FINDINGS = 20;
const MAX_COMMANDS = 20;
const MAX_LOG_EXCERPTS = 10;
const MAX_COMMAND_OR_LOG_BYTES = 2 * 1024;
const MAX_COMMANDS_AND_LOGS_BYTES = 8 * 1024;

const SECRET_KEY_PATTERN =
  /(?:secret|token|password|credential|private[_-]?key|access[_-]?key|api[_-]?key|cookie|authorization|bearer|oauth|env)/i;
const SECRET_OPTION_LABEL_PATTERN =
  /(?:secret|token|password|credential|private[_-]?key|access[_-]?key|api[_-]?key|cookie|authorization|bearer|oauth|env|key)/i;
const PRESERVED_FACTUAL_KEYS = new Set([
  "authProfileKey",
  "authProfileSource",
  "credentialSource",
  "credentialBucket",
  "fallbackCredentialSelected",
  "fallbackProfileSelected",
  "fallbackProfileDecision",
  "fallbackProviderId",
  "fallbackModelId",
  "fallbackProviderDecision",
  "fallbackModelDecision",
]);
const TRANSCRIPT_KEY_PATTERN = /(?:rawTranscript|transcript|messages|history)/i;

export type ChildHandoffSemanticSection = {
  originalTask: string;
  desiredOutcome?: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  findings?: string[];
  filesInspected?: string[];
  commandsInspected?: string[];
  logExcerpts?: string[];
  currentNextStep?: string;
  nonGoals?: string[];
  degradedContext?: boolean;
};

export type ChildHandoffRuntimeEnvelope = {
  requesterSessionKey: string;
  requesterGeneration?: string;
  originalChildSessionKey: string;
  oldChildRunId?: string;
  healthRejectionCodes?: string[];
  recommendedAction: ChildRouteRecommendedAction;
  deliveryAttemptId?: string;
  oldRouteState?: "queued" | "delivered" | "accepted" | "running" | "terminal" | "rejected";
  targetAgentId?: string;
  providerId?: string;
  modelId?: string;
  modelOverrideSource?: string;
  authProfileKey?: string;
  authProfileSource?: string;
  credentialSource?: string;
  credentialBucket?: string;
  fallbackProfileSelected?: boolean;
  fallbackProfileDecision?: string;
  fallbackProviderId?: string;
  fallbackModelId?: string;
  fallbackProviderDecision?: string;
  fallbackModelDecision?: string;
  thinking?: string;
  thinkingOverride?: string;
  fastMode?: boolean;
  reasoningLevel?: string;
  verbosity?: string;
  traceLevel?: string;
  elevatedLevel?: string;
  toolExecHost?: string;
  execSecurity?: string;
  execAskPolicy?: string;
  execNode?: string;
  ttsMode?: string;
  responseUsageMode?: string;
  childTargetKind?: "subagent" | "acp";
  subagentRole?: string;
  controlScope?: string;
  spawnDepth?: number;
  spawnedWorkspace?: string;
  acpBackend?: string;
  acpAgentId?: string;
  acpRuntimeSessionMode?: string;
  acpRuntimeMode?: string;
  acpRuntimeModel?: string;
  acpRuntimeWorkingDirectory?: string;
  acpPermissionProfile?: string;
  acpPerTurnTimeoutSeconds?: number;
  acpBackendOptions?: Array<{ key: string; value?: string; replaySafe: boolean }>;
  featureLabel?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  spawnMode?: "run" | "session";
  cleanup?: "delete" | "keep";
  requesterOrigin?: Record<string, unknown>;
  requesterDisplayKey?: string;
  replacementRole?: string;
  oldUnderlyingSessionId?: string;
  attachmentRoots?: Array<{
    path: string;
    available: boolean;
    retained: boolean;
    readableByReplacement?: boolean;
    missingReason?: string;
  }>;
  retainedAttachmentPolicy?: "retain" | "cleanup" | "none";
  attachmentReferences?: Array<{
    name: string;
    available: boolean;
    mediaType?: string;
    sizeBytes?: number;
    rootPath?: string;
    missingReason?: string;
  }>;
  timestamp: number;
  idempotencyKey?: string;
  extra?: Record<string, unknown>;
};

export type ChildHandoffPacket = {
  version: typeof PACKET_VERSION;
  semantic: ChildHandoffSemanticSection;
  envelope: ChildHandoffRuntimeEnvelope;
  metadata: {
    bytes: number;
    semanticBytes: number;
    envelopeBytes: number;
    truncated: boolean;
    dropped: {
      filesInspected: number;
      findings: number;
      commandsInspected: number;
      logExcerpts: number;
      envelopeFields: number;
      redactedFields: number;
    };
  };
};

export type FreshChildRerouteInput = {
  failure: ChildRouteUnhealthyDetails | ChildRouteHealthUnavailableDetails;
  semantic: ChildHandoffSemanticSection;
  envelope: ChildHandoffRuntimeEnvelope;
  replacement: {
    role: string;
    childSessionKey: string;
    runId: string;
    underlyingSessionId?: string;
  };
};

export type FreshChildRerouteDecision =
  | {
      status: "not_reroutable";
      action: Exclude<ChildRouteRecommendedAction, "spawn_fresh"> | "unavailable";
      plannerInstruction: string;
    }
  | {
      status: "fresh_child_spawned";
      rejectedOldChild: {
        childSessionKey: string;
        deliveryAttemptId?: string;
        generation?: string;
      };
      freshChild: {
        role: string;
        childSessionKey: string;
        runId: string;
        underlyingSessionId?: string;
      };
      handoffPacket: ChildHandoffPacket;
    };

export type ChildCompletionGenerationAttachment =
  | { status: "fresh_child_completion"; runId: string; childSessionKey: string }
  | { status: "old_generation_completion"; runId: string; childSessionKey: string };

function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function countArrayDrops(original: string[] | undefined, kept: string[] | undefined): number {
  return Math.max(0, (original?.length ?? 0) - (kept?.length ?? 0));
}

function truncateUtf8String(
  value: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const redacted = redactText(value);
  if (byteLength(redacted) <= maxBytes) {
    return { value: redacted, truncated: redacted !== value };
  }
  let out = redacted;
  while (byteLength(out) > Math.max(0, maxBytes - 3) && out.length > 0) {
    out = out.slice(0, Math.floor(out.length * 0.9));
  }
  return { value: `${out}...`, truncated: true };
}

function redactText(value: string): string {
  return redactSensitiveText(value);
}

function boundedStrings(
  values: string[] | undefined,
  maxItems: number,
  maxItemBytes = 1024,
): { values: string[] | undefined; dropped: number; truncated: boolean } {
  if (!values) {
    return { values: undefined, dropped: 0, truncated: false };
  }
  let truncated = false;
  const kept = values.slice(0, maxItems).map((item) => {
    const next = truncateUtf8String(item, maxItemBytes);
    truncated ||= next.truncated;
    return next.value;
  });
  return {
    values: kept,
    dropped: Math.max(0, values.length - kept.length),
    truncated,
  };
}

function boundedCommandsAndLogs(params: { commands?: string[]; logs?: string[] }): {
  commands?: string[];
  logs?: string[];
  commandsDropped: number;
  logsDropped: number;
  truncated: boolean;
} {
  const commands = boundedStrings(params.commands, MAX_COMMANDS, MAX_COMMAND_OR_LOG_BYTES);
  const logs = boundedStrings(params.logs, MAX_LOG_EXCERPTS, MAX_COMMAND_OR_LOG_BYTES);
  let keptCommands = commands.values ?? [];
  let keptLogs = logs.values ?? [];
  let commandsDropped = commands.dropped;
  let logsDropped = logs.dropped;
  while (byteLength([...keptCommands, ...keptLogs]) > MAX_COMMANDS_AND_LOGS_BYTES) {
    if (keptLogs.length > 0) {
      keptLogs = keptLogs.slice(0, -1);
      logsDropped += 1;
    } else if (keptCommands.length > 0) {
      keptCommands = keptCommands.slice(0, -1);
      commandsDropped += 1;
    } else {
      break;
    }
  }
  return {
    commands: keptCommands.length > 0 ? keptCommands : undefined,
    logs: keptLogs.length > 0 ? keptLogs : undefined,
    commandsDropped,
    logsDropped,
    truncated: commands.truncated || logs.truncated || commandsDropped > 0 || logsDropped > 0,
  };
}

function redactValue(value: unknown): { value: unknown; redactedFields: number } {
  if (Array.isArray(value)) {
    let redactedFields = 0;
    const items = value.map((item) => {
      const redacted = redactValue(item);
      redactedFields += redacted.redactedFields;
      return redacted.value;
    });
    return { value: items, redactedFields };
  }
  if (!value || typeof value !== "object") {
    return { value, redactedFields: 0 };
  }
  let redactedFields = 0;
  const out: Record<string, unknown> = {};
  const secretLabeledValue =
    typeof (value as { key?: unknown }).key === "string" &&
    SECRET_OPTION_LABEL_PATTERN.test((value as { key: string }).key);
  for (const [key, item] of Object.entries(value)) {
    if (TRANSCRIPT_KEY_PATTERN.test(key)) {
      redactedFields += 1;
      continue;
    }
    if (secretLabeledValue && key === "value") {
      out[key] = "[redacted]";
      redactedFields += 1;
      continue;
    }
    if (secretLabeledValue && key === "replaySafe") {
      out[key] = false;
      continue;
    }
    if (PRESERVED_FACTUAL_KEYS.has(key)) {
      out[key] = typeof item === "string" ? redactText(item) : item;
      continue;
    }
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = "[redacted]";
      redactedFields += 1;
      continue;
    }
    const redacted = redactValue(item);
    redactedFields += redacted.redactedFields;
    out[key] = redacted.value;
  }
  return { value: out, redactedFields };
}

function shrinkEnvelope(envelope: ChildHandoffRuntimeEnvelope): {
  envelope: ChildHandoffRuntimeEnvelope;
  droppedFields: number;
} {
  let next = { ...envelope };
  let droppedFields = 0;
  const optionalKeys: Array<keyof ChildHandoffRuntimeEnvelope> = [
    "extra",
    "acpBackendOptions",
    "attachmentReferences",
    "attachmentRoots",
    "oldUnderlyingSessionId",
    "requesterOrigin",
    "workspaceDir",
    "spawnedWorkspace",
    "acpRuntimeWorkingDirectory",
    "featureLabel",
    "thinking",
    "thinkingOverride",
    "reasoningLevel",
    "verbosity",
    "traceLevel",
    "toolExecHost",
  ];
  for (const key of optionalKeys) {
    if (byteLength(next) <= MAX_ENVELOPE_BYTES) {
      break;
    }
    if (key in next) {
      const { [key]: _dropped, ...rest } = next;
      next = rest as ChildHandoffRuntimeEnvelope;
      droppedFields += 1;
    }
  }
  return { envelope: next, droppedFields };
}

function shrinkSemanticToBudget(semantic: ChildHandoffSemanticSection): void {
  const arrayKeys: Array<keyof ChildHandoffSemanticSection> = [
    "logExcerpts",
    "commandsInspected",
    "findings",
    "filesInspected",
    "nonGoals",
    "constraints",
    "acceptanceCriteria",
  ];
  for (const key of arrayKeys) {
    while (byteLength(semantic) > MAX_SEMANTIC_BYTES) {
      const value = semantic[key];
      if (!Array.isArray(value) || value.length === 0) {
        break;
      }
      (semantic[key] as string[] | undefined) = value.slice(0, -1);
    }
  }
  if (byteLength(semantic) > MAX_SEMANTIC_BYTES && semantic.currentNextStep) {
    semantic.currentNextStep = truncateUtf8String(semantic.currentNextStep, 512).value;
  }
  if (byteLength(semantic) > MAX_SEMANTIC_BYTES && semantic.desiredOutcome) {
    semantic.desiredOutcome = truncateUtf8String(semantic.desiredOutcome, 512).value;
  }
  if (byteLength(semantic) > MAX_SEMANTIC_BYTES) {
    semantic.originalTask = truncateUtf8String(semantic.originalTask, 4 * 1024).value;
  }
}

export function buildChildHandoffPacket(params: {
  semantic: ChildHandoffSemanticSection;
  envelope: ChildHandoffRuntimeEnvelope;
}): ChildHandoffPacket {
  const commandsAndLogs = boundedCommandsAndLogs({
    commands: params.semantic.commandsInspected,
    logs: params.semantic.logExcerpts,
  });
  const files = boundedStrings(params.semantic.filesInspected, MAX_FILE_REFERENCES, 512);
  const findings = boundedStrings(params.semantic.findings, MAX_FINDINGS, 1024);
  const acceptanceCriteria = boundedStrings(params.semantic.acceptanceCriteria, 20, 1024);
  const constraints = boundedStrings(params.semantic.constraints, 20, 1024);
  const nonGoals = boundedStrings(params.semantic.nonGoals, 20, 1024);
  const semantic: ChildHandoffSemanticSection = {
    originalTask: truncateUtf8String(params.semantic.originalTask, 8 * 1024).value,
    ...(params.semantic.desiredOutcome
      ? { desiredOutcome: truncateUtf8String(params.semantic.desiredOutcome, 4 * 1024).value }
      : {}),
    ...(acceptanceCriteria.values ? { acceptanceCriteria: acceptanceCriteria.values } : {}),
    ...(constraints.values ? { constraints: constraints.values } : {}),
    ...(findings.values ? { findings: findings.values } : {}),
    ...(files.values ? { filesInspected: files.values } : {}),
    ...(commandsAndLogs.commands ? { commandsInspected: commandsAndLogs.commands } : {}),
    ...(commandsAndLogs.logs ? { logExcerpts: commandsAndLogs.logs } : {}),
    ...(params.semantic.currentNextStep
      ? { currentNextStep: truncateUtf8String(params.semantic.currentNextStep, 4 * 1024).value }
      : {}),
    ...(nonGoals.values ? { nonGoals: nonGoals.values } : {}),
    ...(params.semantic.degradedContext === true ? { degradedContext: true } : {}),
  };
  shrinkSemanticToBudget(semantic);

  const redactedEnvelope = redactValue(params.envelope);
  const shrunkEnvelope = shrinkEnvelope(redactedEnvelope.value as ChildHandoffRuntimeEnvelope);
  const packetWithoutMeta = {
    version: PACKET_VERSION,
    semantic,
    envelope: shrunkEnvelope.envelope,
  };
  const buildPacket = (forcedTruncated: boolean): ChildHandoffPacket => {
    const baseMetadata = {
      semanticBytes: byteLength(semantic),
      envelopeBytes: byteLength(shrunkEnvelope.envelope),
      truncated:
        forcedTruncated ||
        acceptanceCriteria.truncated ||
        constraints.truncated ||
        findings.truncated ||
        files.truncated ||
        commandsAndLogs.truncated ||
        nonGoals.truncated ||
        shrunkEnvelope.droppedFields > 0,
      dropped: {
        filesInspected: countArrayDrops(params.semantic.filesInspected, semantic.filesInspected),
        findings: countArrayDrops(params.semantic.findings, semantic.findings),
        commandsInspected: countArrayDrops(
          params.semantic.commandsInspected,
          semantic.commandsInspected,
        ),
        logExcerpts: countArrayDrops(params.semantic.logExcerpts, semantic.logExcerpts),
        envelopeFields: shrunkEnvelope.droppedFields,
        redactedFields: redactedEnvelope.redactedFields,
      },
    };
    let bytes = 0;
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const nextBytes = byteLength({
        ...packetWithoutMeta,
        metadata: { bytes, ...baseMetadata },
      });
      if (nextBytes === bytes) {
        break;
      }
      bytes = nextBytes;
    }
    return {
      ...packetWithoutMeta,
      metadata: { bytes, ...baseMetadata },
    };
  };
  let forcedTruncated = false;
  let packet = buildPacket(forcedTruncated);
  if (packet.metadata.bytes > MAX_PACKET_BYTES) {
    forcedTruncated = true;
    semantic.currentNextStep = semantic.currentNextStep
      ? truncateUtf8String(semantic.currentNextStep, 1024).value
      : undefined;
    semantic.desiredOutcome = semantic.desiredOutcome
      ? truncateUtf8String(semantic.desiredOutcome, 1024).value
      : undefined;
    packet = buildPacket(forcedTruncated);
  }
  if (packet.metadata.bytes > MAX_PACKET_BYTES) {
    semantic.findings = undefined;
    semantic.commandsInspected = undefined;
    semantic.logExcerpts = undefined;
    packet = buildPacket(forcedTruncated);
  }
  if (packet.metadata.bytes > MAX_PACKET_BYTES) {
    semantic.acceptanceCriteria = undefined;
    semantic.constraints = undefined;
    semantic.filesInspected = undefined;
    semantic.nonGoals = undefined;
    semantic.currentNextStep = undefined;
    semantic.desiredOutcome = undefined;
    semantic.originalTask = truncateUtf8String(semantic.originalTask, 512).value;
    packet = buildPacket(forcedTruncated);
  }
  return packet;
}

function recommendedActionFromFailure(
  failure: ChildRouteUnhealthyDetails | ChildRouteHealthUnavailableDetails,
): ChildRouteRecommendedAction | "unavailable" {
  return failure.kind === "child_route_unhealthy" ? failure.recommendedAction : "unavailable";
}

export function decideFreshChildReroute(input: FreshChildRerouteInput): FreshChildRerouteDecision {
  const action = recommendedActionFromFailure(input.failure);
  if (action !== "spawn_fresh") {
    return {
      status: "not_reroutable",
      action,
      plannerInstruction: input.failure.plannerInstruction,
    };
  }
  const oldSessionId = input.envelope.oldUnderlyingSessionId?.trim();
  const replacementSessionId = input.replacement.underlyingSessionId?.trim();
  if (oldSessionId && replacementSessionId && oldSessionId === replacementSessionId) {
    return {
      status: "not_reroutable",
      action: "stop",
      plannerInstruction:
        "Replacement child must use a fresh child generation or underlying session id.",
    };
  }
  const oldChild =
    input.failure.kind === "child_route_unhealthy"
      ? input.failure.childSessionKey
      : input.envelope.originalChildSessionKey;
  return {
    status: "fresh_child_spawned",
    rejectedOldChild: {
      childSessionKey: oldChild,
      ...(input.failure.kind === "child_route_unhealthy"
        ? { deliveryAttemptId: input.failure.deliveryAttemptId }
        : {}),
      generation: input.envelope.oldChildRunId,
    },
    freshChild: input.replacement,
    handoffPacket: buildChildHandoffPacket({
      semantic: input.semantic,
      envelope: {
        ...input.envelope,
        replacementRole: input.replacement.role,
      },
    }),
  };
}

export function attachChildCompletionToGeneration(params: {
  completionRunId: string;
  completionChildSessionKey: string;
  freshRunId: string;
  freshChildSessionKey: string;
}): ChildCompletionGenerationAttachment {
  if (
    params.completionRunId === params.freshRunId &&
    params.completionChildSessionKey === params.freshChildSessionKey
  ) {
    return {
      status: "fresh_child_completion",
      runId: params.completionRunId,
      childSessionKey: params.completionChildSessionKey,
    };
  }
  return {
    status: "old_generation_completion",
    runId: params.completionRunId,
    childSessionKey: params.completionChildSessionKey,
  };
}
