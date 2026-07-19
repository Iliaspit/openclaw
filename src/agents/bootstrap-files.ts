import fs from "node:fs/promises";
import type { AgentContextInjection } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { getOrLoadBootstrapFiles } from "./bootstrap-cache.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import { shouldIncludeHeartbeatGuidanceForSystemPrompt } from "./heartbeat-system-prompt.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import {
  buildBootstrapContextFiles,
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "./pi-embedded-helpers.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  filterBootstrapFilesForSession,
  isWorkspaceBootstrapPending,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

export type BootstrapContextMode = "full" | "lightweight";
export type BootstrapContextRunKind = "default" | "heartbeat" | "cron";

const CONTINUATION_SCAN_MAX_TAIL_BYTES = 256 * 1024;
const CONTINUATION_SCAN_MAX_RECORDS = 500;
export const FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE = "openclaw:bootstrap-context:full";
const BOOTSTRAP_WARNING_DEDUPE_LIMIT = 1024;
const seenBootstrapWarnings = new Set<string>();
const bootstrapWarningOrder: string[] = [];

function rememberBootstrapWarning(key: string): boolean {
  if (seenBootstrapWarnings.has(key)) {
    return false;
  }
  if (seenBootstrapWarnings.size >= BOOTSTRAP_WARNING_DEDUPE_LIMIT) {
    const oldest = bootstrapWarningOrder.shift();
    if (oldest) {
      seenBootstrapWarnings.delete(oldest);
    }
  }
  seenBootstrapWarnings.add(key);
  bootstrapWarningOrder.push(key);
  return true;
}

export function _resetBootstrapWarningCacheForTest(): void {
  seenBootstrapWarnings.clear();
  bootstrapWarningOrder.length = 0;
}

export function resolveContextInjectionMode(config?: OpenClawConfig): AgentContextInjection {
  return config?.agents?.defaults?.contextInjection ?? "always";
}

export async function hasCompletedBootstrapTurn(sessionFile: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(sessionFile);
    if (stat.isSymbolicLink()) {
      return false;
    }

    const fh = await fs.open(sessionFile, "r");
    try {
      const bytesToRead = Math.min(stat.size, CONTINUATION_SCAN_MAX_TAIL_BYTES);
      if (bytesToRead <= 0) {
        return false;
      }
      const start = stat.size - bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await fh.read(buffer, 0, bytesToRead, start);
      let text = buffer.toString("utf-8", 0, bytesRead);
      if (start > 0) {
        const firstNewline = text.indexOf("\n");
        if (firstNewline === -1) {
          return false;
        }
        text = text.slice(firstNewline + 1);
      }

      const records = text
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .slice(-CONTINUATION_SCAN_MAX_RECORDS);
      let compactedAfterLatestAssistant = false;

      for (let i = records.length - 1; i >= 0; i--) {
        const line = records[i];
        if (!line) {
          continue;
        }
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const record = entry as
          | {
              type?: string;
              customType?: string;
              message?: { role?: string };
            }
          | null
          | undefined;
        if (record?.type === "compaction") {
          compactedAfterLatestAssistant = true;
          continue;
        }
        if (
          record?.type === "custom" &&
          record.customType === FULL_BOOTSTRAP_COMPLETED_CUSTOM_TYPE
        ) {
          return !compactedAfterLatestAssistant;
        }
      }

      return false;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

export function makeBootstrapWarn(params: {
  sessionLabel: string;
  workspaceDir?: string;
  warn?: (message: string) => void;
}): ((message: string) => void) | undefined {
  const warn = params.warn;
  if (!warn) {
    return undefined;
  }
  const workspacePrefix = params.workspaceDir ?? "";
  return (message: string) => {
    const key = `${workspacePrefix}\u0000${params.sessionLabel}\u0000${message}`;
    if (!rememberBootstrapWarning(key)) {
      return;
    }
    warn(`${message} (sessionKey=${params.sessionLabel})`);
  };
}

function sanitizeBootstrapFiles(
  files: WorkspaceBootstrapFile[],
  warn?: (message: string) => void,
): WorkspaceBootstrapFile[] {
  const sanitized: WorkspaceBootstrapFile[] = [];
  for (const file of files) {
    const pathValue = normalizeOptionalString(file.path) ?? "";
    if (!pathValue) {
      warn?.(
        `skipping bootstrap file "${file.name}" — missing or invalid "path" field (hook may have used "filePath" instead)`,
      );
      continue;
    }
    sanitized.push({ ...file, path: pathValue });
  }
  return sanitized;
}

function applyContextModeFilter(params: {
  files: WorkspaceBootstrapFile[];
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): WorkspaceBootstrapFile[] {
  const contextMode = params.contextMode ?? "full";
  const runKind = params.runKind ?? "default";
  if (contextMode !== "lightweight") {
    return params.files;
  }
  if (runKind === "heartbeat") {
    return params.files.filter((file) => file.name === "HEARTBEAT.md");
  }
  // cron/default lightweight mode keeps bootstrap context empty on purpose.
  return [];
}

function shouldExcludeHeartbeatBootstrapFile(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  runKind?: BootstrapContextRunKind;
}): boolean {
  if (!params.config || params.runKind === "heartbeat") {
    return false;
  }
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey ?? params.sessionId,
    config: params.config,
    agentId: params.agentId,
  });
  if (sessionAgentId !== defaultAgentId) {
    return false;
  }
  return !shouldIncludeHeartbeatGuidanceForSystemPrompt({
    config: params.config,
    agentId: sessionAgentId,
    defaultAgentId,
  });
}

function filterHeartbeatBootstrapFile(
  files: WorkspaceBootstrapFile[],
  excludeHeartbeatBootstrapFile: boolean,
): WorkspaceBootstrapFile[] {
  if (!excludeHeartbeatBootstrapFile) {
    return files;
  }
  return files.filter((file) => file.name !== DEFAULT_HEARTBEAT_FILENAME);
}

const ALWAYS_SUBSTANTIVE_BOOTSTRAP_FILES = new Set([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
]);

const TEMPLATE_ONLY_LINE_PATTERNS_BY_FILE: Partial<
  Record<WorkspaceBootstrapFile["name"], readonly RegExp[]>
> = {
  [DEFAULT_SOUL_FILENAME]: [
    /^_?you're not a chatbot\. you're becoming someone\.?_?$/i,
    /^want a sharper version\? see \[soul\.md personality guide\]\(\/concepts\/soul\)\.?$/i,
    /^\*\*be genuinely helpful, not performatively helpful\./i,
    /^\*\*have opinions\./i,
    /^\*\*be resourceful before asking\./i,
    /^\*\*earn trust through competence\./i,
    /^\*\*remember you're a guest\./i,
    /^private things stay private\. period\.$/i,
    /^when in doubt, ask before acting externally\.$/i,
    /^never send half-baked replies to messaging surfaces\.$/i,
    /^you're not the user's voice/i,
    /^be the assistant you'd actually want to talk to\./i,
    /^each session, you wake up fresh\./i,
    /^if you change this file, tell the user/i,
    /^_?this file is yours to evolve\./i,
  ],
  [DEFAULT_TOOLS_FILENAME]: [
    /^skills define _?\\?\*?how_?\\?\*? tools work\./i,
    /^this file is for _?\\?\*?your_?\\?\*? specifics/i,
    /^things like:$/i,
    /^- camera names and locations$/i,
    /^- ssh hosts and aliases$/i,
    /^- preferred voices for tts$/i,
    /^- speaker\/room names$/i,
    /^- device nicknames$/i,
    /^- anything environment-specific$/i,
    /^- living-room .+ main area/i,
    /^- front-door .+ entrance/i,
    /^- home-server .+ 192\.168\.1\.100/i,
    /^- preferred voice:/i,
    /^- default speaker:/i,
    /^skills are shared\. your setup is yours\./i,
    /^keeping them apart means you can update skills/i,
    /^add whatever helps you do your job\. this is your cheat sheet\.$/i,
  ],
  [DEFAULT_IDENTITY_FILENAME]: [
    /^_?\\?\*?fill this in during your first conversation/i,
    /^- \*\*name:\*\*$/i,
    /^- \*\*creature:\*\*$/i,
    /^- \*\*vibe:\*\*$/i,
    /^- \*\*emoji:\*\*$/i,
    /^- \*\*avatar:\*\*$/i,
    /^_?\\?\*?\(pick something you like\)_?\\?\*?$/i,
    /^_?\\?\*?\(ai\? robot\? familiar\? ghost in the machine\? something weirder\?\)_?\\?\*?$/i,
    /^_?\\?\*?\(how do you come across\? sharp\? warm\? chaotic\? calm\?\)_?\\?\*?$/i,
    /^_?\\?\*?\(your signature/i,
    /^_?\\?\*?\(workspace-relative path, http\(s\) url, or data uri\)_?\\?\*?$/i,
    /^this isn't just metadata\. it's the start of figuring out who you are\.$/i,
    /^notes:?$/i,
    /^- save this file at the workspace root as `identity\.md`\.$/i,
    /^- for avatars, use a workspace-relative path like `avatars\/openclaw\.png`\.$/i,
  ],
  [DEFAULT_USER_FILENAME]: [
    /^_?\\?\*?learn about the person you're helping/i,
    /^- \*\*name:\*\*$/i,
    /^- \*\*what to call them:\*\*$/i,
    /^- \*\*pronouns:\*\*/i,
    /^- \*\*timezone:\*\*$/i,
    /^- \*\*notes:\*\*$/i,
    /^_?\\?\*?\(what do they care about\? what projects are they working on\? what annoys them\? what makes them laugh\? build this over time\.\)_?\\?\*?$/i,
    /^the more you know, the better you can help\./i,
  ],
  [DEFAULT_HEARTBEAT_FILENAME]: [
    /^# keep this file empty \(or with only comments\) to skip heartbeat api calls\.$/i,
    /^# add tasks below when you want the agent to check something periodically\.$/i,
  ],
};

function isCommonTemplateOnlyLine(line: string): boolean {
  return (
    line === "---" ||
    /^summary:/i.test(line) ||
    /^title:/i.test(line) ||
    /^read_when:/i.test(line) ||
    /^-\s+bootstrapping a workspace manually$/i.test(line) ||
    /^#+(\s|$)/.test(line) ||
    /^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(line) ||
    /^```[A-Za-z0-9_-]*$/.test(line) ||
    /^\[agent workspace\]\(\/concepts\/agent-workspace\)$/i.test(line) ||
    /^-\s+\[agent workspace\]\(\/concepts\/agent-workspace\)$/i.test(line) ||
    /^-\s+\[heartbeat config\]\(\/gateway\/config-agents\)$/i.test(line) ||
    /^-\s+\[soul\.md personality guide\]\(\/concepts\/soul\)$/i.test(line)
  );
}

function isTemplateOnlyLine(fileName: WorkspaceBootstrapFile["name"], line: string): boolean {
  if (isCommonTemplateOnlyLine(line)) {
    return true;
  }
  return (
    TEMPLATE_ONLY_LINE_PATTERNS_BY_FILE[fileName]?.some((pattern) => pattern.test(line)) === true
  );
}

function isSubstantiveBootstrapFile(file: WorkspaceBootstrapFile): boolean {
  if (file.missing) {
    return false;
  }
  const content = file.content ?? "";
  if (!content.trim()) {
    return false;
  }
  const lines = content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  if (ALWAYS_SUBSTANTIVE_BOOTSTRAP_FILES.has(file.name)) {
    return lines.some((line) => !isCommonTemplateOnlyLine(line));
  }
  if (file.name === DEFAULT_MEMORY_FILENAME) {
    return lines.some((line) => !isCommonTemplateOnlyLine(line));
  }
  return lines.some((line) => !isTemplateOnlyLine(file.name, line));
}

function filterNonSubstantiveBootstrapFiles(
  files: WorkspaceBootstrapFile[],
): WorkspaceBootstrapFile[] {
  return files.filter(isSubstantiveBootstrapFile);
}

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
}): Promise<WorkspaceBootstrapFile[]> {
  const excludeHeartbeatBootstrapFile = shouldExcludeHeartbeatBootstrapFile(params);
  const sessionKey = params.sessionKey ?? params.sessionId;
  const rawFiles = params.sessionKey
    ? await getOrLoadBootstrapFiles({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
      })
    : await loadWorkspaceBootstrapFiles(params.workspaceDir);
  const bootstrapFiles = applyContextModeFilter({
    files: filterBootstrapFilesForSession(rawFiles, sessionKey),
    contextMode: params.contextMode,
    runKind: params.runKind,
  });

  const updated = await applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
  return filterNonSubstantiveBootstrapFiles(
    sanitizeBootstrapFiles(
      filterHeartbeatBootstrapFile(updated, excludeHeartbeatBootstrapFile),
      params.warn,
    ),
  );
}

export async function resolveBootstrapContextForRun(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
  allowPolicyTruncationForDiagnostics?: boolean;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  const contextFiles = buildBootstrapContextFiles(bootstrapFiles, {
    maxChars: resolveBootstrapMaxChars(params.config),
    totalMaxChars: resolveBootstrapTotalMaxChars(params.config),
    warn: params.warn,
    allowPolicyTruncationForDiagnostics: params.allowPolicyTruncationForDiagnostics,
  });
  return { bootstrapFiles, contextFiles };
}

export { isWorkspaceBootstrapPending };
