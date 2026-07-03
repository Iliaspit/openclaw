import { createHash } from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { getProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import type { AgentInternalEvent, AgentResultReceipt } from "./internal-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const RESULT_RECEIPTS_VERSION = 1 as const;
const JSON_FILE_MODE = 0o600;
const MAX_RECEIPTS_TOTAL = 5_000;
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const RECEIPT_LOCK_TIMEOUT_MS = 10_000;
const RECEIPT_LOCK_STALE_MS = 30 * 60_000;
const RECEIPT_LOCK_RETRY_MS = 25;

export type SubagentResultReceipt = AgentResultReceipt & {
  id: string;
  kind: "subagent_result";
  childSessionKey: string;
  childRunId: string;
  requiredRead: true;
  bytes: number;
  sha256?: string;
  capturedAt?: number;
};

type PersistedSubagentResultReceipt = SubagentResultReceipt & {
  version: typeof RESULT_RECEIPTS_VERSION;
  resultText: string;
  requesterSessionKey?: string;
  task?: string;
  outcomeStatus?: string;
  observedAt: number;
};

type PersistedSubagentResultReceiptState = {
  version: typeof RESULT_RECEIPTS_VERSION;
  receipts: Record<string, PersistedSubagentResultReceipt>;
  runIndex: Record<string, string>;
};

type ReceiptStoreLockPayload = {
  pid?: number;
  createdAt?: string;
  starttime?: number;
};

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function resolveSubagentStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) {
    return path.join(resolveStateDir(env), "subagents");
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), "openclaw-test-state", String(process.pid), "subagents");
  }
  return path.join(resolveStateDir(env), "subagents");
}

export function resolveSubagentResultReceiptsPath(): string {
  return path.join(resolveSubagentStateDir(process.env), "result-receipts.json");
}

function emptyReceiptState(): PersistedSubagentResultReceiptState {
  return {
    version: RESULT_RECEIPTS_VERSION,
    receipts: {},
    runIndex: {},
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isValidLockNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function normalizePersistedReceipt(raw: unknown): PersistedSubagentResultReceipt | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = normalizeOptionalString(record.id);
  const childSessionKey = normalizeOptionalString(record.childSessionKey);
  const childRunId = normalizeOptionalString(record.childRunId);
  const resultText = typeof record.resultText === "string" ? record.resultText : undefined;
  const observedAt = typeof record.observedAt === "number" ? record.observedAt : undefined;
  if (
    record.version !== RESULT_RECEIPTS_VERSION ||
    record.kind !== "subagent_result" ||
    !id ||
    !childSessionKey ||
    !childRunId ||
    resultText === undefined ||
    observedAt === undefined
  ) {
    return null;
  }
  const bytes =
    typeof record.bytes === "number" && Number.isFinite(record.bytes)
      ? Math.max(0, Math.floor(record.bytes))
      : Buffer.byteLength(resultText, "utf8");
  return {
    version: RESULT_RECEIPTS_VERSION,
    id,
    kind: "subagent_result",
    childSessionKey,
    childRunId,
    requiredRead: true,
    bytes,
    ...(normalizeOptionalString(record.sha256)
      ? { sha256: normalizeOptionalString(record.sha256) }
      : {}),
    ...(typeof record.capturedAt === "number" ? { capturedAt: record.capturedAt } : {}),
    resultText,
    ...(normalizeOptionalString(record.requesterSessionKey)
      ? { requesterSessionKey: normalizeOptionalString(record.requesterSessionKey) }
      : {}),
    ...(normalizeOptionalString(record.task) ? { task: normalizeOptionalString(record.task) } : {}),
    ...(normalizeOptionalString(record.outcomeStatus)
      ? { outcomeStatus: normalizeOptionalString(record.outcomeStatus) }
      : {}),
    observedAt,
  };
}

function normalizeReceiptState(raw: unknown): PersistedSubagentResultReceiptState {
  if (!raw || typeof raw !== "object") {
    throw new Error("result-receipt store is not an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== RESULT_RECEIPTS_VERSION) {
    throw new Error("unsupported result-receipt store version");
  }
  const state = emptyReceiptState();
  if (record.receipts && typeof record.receipts === "object") {
    for (const [key, value] of Object.entries(record.receipts)) {
      const receipt = normalizePersistedReceipt(value);
      if (receipt && key === receipt.id) {
        state.receipts[key] = receipt;
        state.runIndex[`${receipt.childSessionKey}:${receipt.childRunId}`] = receipt.id;
      }
    }
  }
  return state;
}

function readReceiptStateFromPathSync(pathname: string): PersistedSubagentResultReceiptState {
  try {
    const raw = fsSync.readFileSync(pathname, "utf8");
    return normalizeReceiptState(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyReceiptState();
    }
    throw error;
  }
}

function applyReceiptRetention(
  state: PersistedSubagentResultReceiptState,
  now: number,
): PersistedSubagentResultReceiptState {
  const receipts = Object.values(state.receipts)
    .filter((receipt) => now - receipt.observedAt <= RECEIPT_RETENTION_MS)
    .toSorted(
      (left, right) => right.observedAt - left.observedAt || right.id.localeCompare(left.id),
    )
    .slice(0, MAX_RECEIPTS_TOTAL);
  state.receipts = {};
  state.runIndex = {};
  for (const receipt of receipts) {
    state.receipts[receipt.id] = receipt;
    state.runIndex[`${receipt.childSessionKey}:${receipt.childRunId}`] = receipt.id;
  }
  return state;
}

function writeReceiptStateToPathSync(
  pathname: string,
  state: PersistedSubagentResultReceiptState,
): void {
  fsSync.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  fsSync.writeFileSync(pathname, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: JSON_FILE_MODE,
  });
}

function readReceiptStoreLockPayloadSync(lockPath: string): ReceiptStoreLockPayload | null {
  try {
    const raw = fsSync.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const payload: ReceiptStoreLockPayload = {};
    if (isValidLockNumber(parsed.pid) && parsed.pid > 0) {
      payload.pid = parsed.pid;
    }
    if (typeof parsed.createdAt === "string") {
      payload.createdAt = parsed.createdAt;
    }
    if (isValidLockNumber(parsed.starttime)) {
      payload.starttime = parsed.starttime;
    }
    return payload;
  } catch {
    return null;
  }
}

function shouldReclaimReceiptStoreLockSync(lockPath: string): boolean {
  const payload = readReceiptStoreLockPayloadSync(lockPath);
  const pid = isValidLockNumber(payload?.pid) && payload.pid > 0 ? payload.pid : null;
  const pidAlive = pid !== null ? isPidAlive(pid) : false;
  const createdAtMs =
    typeof payload?.createdAt === "string" ? Date.parse(payload.createdAt) : Number.NaN;
  const ageMs = Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : Number.NaN;
  if (pid === null || !pidAlive || ageMs > RECEIPT_LOCK_STALE_MS) {
    return true;
  }
  const storedStarttime = isValidLockNumber(payload?.starttime) ? payload.starttime : null;
  if (storedStarttime !== null) {
    const currentStarttime = getProcessStartTime(pid);
    if (currentStarttime !== null && currentStarttime !== storedStarttime) {
      return true;
    }
  }
  try {
    const stat = fsSync.statSync(lockPath);
    return Date.now() - stat.mtimeMs > RECEIPT_LOCK_STALE_MS;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, Math.max(1, Math.floor(ms)));
}

function acquireReceiptStoreLockSync(pathname: string): { release: () => void } {
  const normalizedPath = path.resolve(pathname);
  const dir = path.dirname(normalizedPath);
  fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = `${normalizedPath}.lock`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < RECEIPT_LOCK_TIMEOUT_MS) {
    let fd: number | undefined;
    try {
      fd = fsSync.openSync(lockPath, "wx");
      const payload: ReceiptStoreLockPayload = {
        pid: process.pid,
        createdAt: new Date().toISOString(),
      };
      const starttime = getProcessStartTime(process.pid);
      if (starttime !== null) {
        payload.starttime = starttime;
      }
      fsSync.writeFileSync(fd, JSON.stringify(payload, null, 2), "utf8");
      return {
        release: () => {
          try {
            if (fd !== undefined) {
              fsSync.closeSync(fd);
            }
          } catch {
            // Best-effort release.
          }
          try {
            fsSync.rmSync(lockPath, { force: true });
          } catch {
            // Best-effort release.
          }
        },
      };
    } catch (error) {
      if (fd !== undefined) {
        try {
          fsSync.closeSync(fd);
        } catch {
          // Best-effort cleanup.
        }
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      if (shouldReclaimReceiptStoreLockSync(lockPath)) {
        try {
          fsSync.rmSync(lockPath, { force: true });
          continue;
        } catch {
          // Retry below.
        }
      }
      sleepSync(RECEIPT_LOCK_RETRY_MS);
    }
  }
  const payload = readReceiptStoreLockPayloadSync(lockPath);
  const owner = typeof payload?.pid === "number" ? `pid=${payload.pid}` : "unknown";
  throw new Error(`result-receipt store locked (timeout ${RECEIPT_LOCK_TIMEOUT_MS}ms): ${owner}`);
}

export function buildSubagentResultReceiptId(params: {
  childSessionKey: string;
  childRunId: string;
}): string {
  const source = `${params.childSessionKey.trim()}:${params.childRunId.trim()}`;
  const digest = sha256Hex(source).slice(0, 24);
  return `scr_${digest}`;
}

export function buildSubagentResultReceipt(params: {
  childSessionKey: string;
  childRunId: string;
  resultText?: string | null;
  capturedAt?: number;
}): SubagentResultReceipt {
  const resultText = params.resultText ?? "";
  return {
    id: buildSubagentResultReceiptId(params),
    kind: "subagent_result",
    childSessionKey: params.childSessionKey,
    childRunId: params.childRunId,
    requiredRead: true,
    bytes: Buffer.byteLength(resultText, "utf8"),
    ...(resultText ? { sha256: sha256Hex(resultText) } : {}),
    ...(typeof params.capturedAt === "number" ? { capturedAt: params.capturedAt } : {}),
  };
}

function buildPersistedReceiptFromRun(entry: SubagentRunRecord): PersistedSubagentResultReceipt {
  const resultText = typeof entry.frozenResultText === "string" ? entry.frozenResultText : "";
  const receipt = buildSubagentResultReceipt({
    childSessionKey: entry.childSessionKey,
    childRunId: entry.runId,
    resultText,
    capturedAt: entry.frozenResultCapturedAt,
  });
  return {
    version: RESULT_RECEIPTS_VERSION,
    ...receipt,
    resultText,
    requesterSessionKey: entry.requesterSessionKey,
    task: entry.task,
    ...(entry.outcome?.status ? { outcomeStatus: entry.outcome.status } : {}),
    observedAt: Date.now(),
  };
}

export function applySubagentResultReceiptToRun(entry: SubagentRunRecord): boolean {
  const resultText = typeof entry.frozenResultText === "string" ? entry.frozenResultText : "";
  const receipt = buildSubagentResultReceipt({
    childSessionKey: entry.childSessionKey,
    childRunId: entry.runId,
    resultText,
    capturedAt: entry.frozenResultCapturedAt,
  });
  let changed = false;
  const assign = <K extends keyof SubagentRunRecord>(key: K, value: SubagentRunRecord[K]) => {
    if (entry[key] === value) {
      return;
    }
    entry[key] = value;
    changed = true;
  };
  assign("resultReceiptId", receipt.id);
  assign("resultReceiptBytes", receipt.bytes);
  assign("resultReceiptSha256", receipt.sha256);
  assign("resultReceiptCapturedAt", receipt.capturedAt);
  return changed;
}

export async function persistSubagentResultReceiptForRun(
  entry: SubagentRunRecord,
): Promise<{ ok: true; receipt: PersistedSubagentResultReceipt } | { ok: false; error: string }> {
  return persistSubagentResultReceiptForRunSync(entry);
}

export function persistSubagentResultReceiptForRunSync(
  entry: SubagentRunRecord,
): { ok: true; receipt: PersistedSubagentResultReceipt } | { ok: false; error: string } {
  const pathname = resolveSubagentResultReceiptsPath();
  let lock: { release: () => void } | undefined;
  try {
    const receipt = buildPersistedReceiptFromRun(entry);
    applySubagentResultReceiptToRun(entry);
    lock = acquireReceiptStoreLockSync(pathname);
    const state = applyReceiptRetention(readReceiptStateFromPathSync(pathname), Date.now());
    state.receipts[receipt.id] = receipt;
    state.runIndex[`${receipt.childSessionKey}:${receipt.childRunId}`] = receipt.id;
    writeReceiptStateToPathSync(pathname, applyReceiptRetention(state, Date.now()));
    return { ok: true, receipt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    lock?.release();
  }
}

function findReceiptRun(
  receiptId: string,
  runs: Map<string, SubagentRunRecord>,
): SubagentRunRecord | undefined {
  const id = receiptId.trim();
  if (!id) {
    return undefined;
  }
  for (const entry of runs.values()) {
    if (entry.resultReceiptId === id) {
      return entry;
    }
    if (
      buildSubagentResultReceiptId({
        childSessionKey: entry.childSessionKey,
        childRunId: entry.runId,
      }) === id
    ) {
      return entry;
    }
  }
  return undefined;
}

function findPersistedReceipt(receiptId: string): PersistedSubagentResultReceipt | undefined {
  const id = receiptId.trim();
  if (!id) {
    return undefined;
  }
  try {
    return readReceiptStateFromPathSync(resolveSubagentResultReceiptsPath()).receipts[id];
  } catch {
    return undefined;
  }
}

export function hydrateAgentInternalEventResultReceiptsFromRuns(
  events: AgentInternalEvent[] | undefined,
  runs: Map<string, SubagentRunRecord>,
): AgentInternalEvent[] | undefined {
  if (!events || events.length === 0) {
    return events;
  }
  let changed = false;
  const hydrated = events.map((event) => {
    if (event.type !== "task_completion" || event.resultReceipt?.kind !== "subagent_result") {
      return event;
    }
    const entry = findReceiptRun(event.resultReceipt.id, runs);
    const persisted = entry ? undefined : findPersistedReceipt(event.resultReceipt.id);
    const resultText =
      typeof entry?.frozenResultText === "string"
        ? entry.frozenResultText
        : (persisted?.resultText ?? "");
    if (!resultText.trim()) {
      return event;
    }
    changed = true;
    return {
      ...event,
      result: resultText,
      resultReceipt: {
        ...event.resultReceipt,
        bytes: event.resultReceipt.bytes ?? Buffer.byteLength(resultText, "utf8"),
        sha256: event.resultReceipt.sha256 ?? sha256Hex(resultText),
        hydrated: true,
      },
    };
  });
  return changed ? hydrated : events;
}

export function hydrateAgentInternalEventResultReceipts(
  events: AgentInternalEvent[] | undefined,
): AgentInternalEvent[] | undefined {
  return hydrateAgentInternalEventResultReceiptsFromRuns(
    events,
    getSubagentRunsSnapshotForRead(subagentRuns),
  );
}
