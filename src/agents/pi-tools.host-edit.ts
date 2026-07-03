import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { expandHomePrefix, resolveOsHomeDir } from "../infra/home-dir.js";
import { recordChildRouteEditFailure, recordChildRouteEditSuccess } from "./child-route-health.js";
import { getToolParamsRecord } from "./pi-tools.params.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

type EditToolRecoveryOptions = {
  root: string;
  readFile: (absolutePath: string) => Promise<string>;
  routeHealth?: {
    childSessionKey?: string;
    runId?: string;
  };
};

type EditToolParams = {
  pathParam?: string;
  edits: EditReplacement[];
};

type EditReplacement = {
  oldText: string;
  newText: string;
};

const EDIT_MISMATCH_MESSAGE = "Could not find the exact text in";
const EDIT_MISMATCH_HINT_LIMIT = 800;
const AMBIGUOUS_EDIT_PATTERNS = [
  /\bmultiple\b.{0,40}\b(matches|occurrences)\b/i,
  /\b(oldText|old text)\b.{0,60}\b(not unique|ambiguous|appears multiple|multiple occurrences)\b/i,
  /\bnot unique\b.{0,40}\b(oldText|old text|edit anchor)\b/i,
];

function resolveEditPath(root: string, pathParam: string): string {
  const home = resolveOsHomeDir();
  const expanded = home ? expandHomePrefix(pathParam, { home }) : pathParam;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}

function readStringParam(record: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function readEditReplacements(record: Record<string, unknown> | undefined): EditReplacement[] {
  if (!Array.isArray(record?.edits)) {
    return [];
  }
  return record.edits.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const replacement = entry as Record<string, unknown>;
    if (typeof replacement.oldText !== "string" || replacement.oldText.trim().length === 0) {
      return [];
    }
    if (typeof replacement.newText !== "string") {
      return [];
    }
    return [{ oldText: replacement.oldText, newText: replacement.newText }];
  });
}

function readEditToolParams(params: unknown): EditToolParams {
  const record = getToolParamsRecord(params);
  return {
    pathParam: readStringParam(record, "path"),
    edits: readEditReplacements(record),
  };
}

function normalizeToLF(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function removeExactOccurrences(content: string, needle: string): string {
  return needle.length > 0 ? content.split(needle).join("") : content;
}

function didEditLikelyApply(params: {
  originalContent?: string;
  currentContent: string;
  edits: EditReplacement[];
}) {
  if (params.edits.length === 0) {
    return false;
  }
  const normalizedCurrent = normalizeToLF(params.currentContent);
  const normalizedOriginal =
    typeof params.originalContent === "string" ? normalizeToLF(params.originalContent) : undefined;

  if (normalizedOriginal !== undefined && normalizedOriginal === normalizedCurrent) {
    return false;
  }

  let withoutInsertedNewText = normalizedCurrent;
  for (const edit of params.edits) {
    const normalizedNew = normalizeToLF(edit.newText);
    if (normalizedNew.length > 0 && !normalizedCurrent.includes(normalizedNew)) {
      return false;
    }
    withoutInsertedNewText =
      normalizedNew.length > 0
        ? removeExactOccurrences(withoutInsertedNewText, normalizedNew)
        : withoutInsertedNewText;
  }

  for (const edit of params.edits) {
    const normalizedOld = normalizeToLF(edit.oldText);
    if (withoutInsertedNewText.includes(normalizedOld)) {
      return false;
    }
  }

  return true;
}

function buildEditSuccessResult(pathParam: string, editCount: number): AgentToolResult<unknown> {
  const text =
    editCount > 1
      ? `Successfully replaced ${editCount} block(s) in ${pathParam}.`
      : `Successfully replaced text in ${pathParam}.`;
  return {
    isError: false,
    content: [
      {
        type: "text",
        text,
      },
    ],
    details: { diff: "", firstChangedLine: undefined },
  } as AgentToolResult<unknown>;
}

function shouldAddMismatchHint(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes(EDIT_MISMATCH_MESSAGE) ||
      error.message.includes("Missing required parameter: edits") ||
      error.message.includes("Missing required parameters: edits"))
  );
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(needle, offset);
    if (index === -1) {
      break;
    }
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function classifyMechanicalEditFailure(params: {
  error: unknown;
  currentContent?: string;
  edits: EditReplacement[];
}): "old_text_mismatch" | "ambiguous_old_text" | "mechanical_edit_failure" | undefined {
  if (typeof params.currentContent === "string" && params.edits.length > 0) {
    const normalizedCurrent = normalizeToLF(params.currentContent);
    const counts = params.edits.map((edit) =>
      countOccurrences(normalizedCurrent, normalizeToLF(edit.oldText)),
    );
    if (counts.some((count) => count > 1)) {
      return "ambiguous_old_text";
    }
    if (counts.some((count) => count === 0)) {
      return "old_text_mismatch";
    }
  }
  const error = params.error;
  if (!(error instanceof Error)) {
    return undefined;
  }
  if (
    error.message.includes("Missing required parameter: edits") ||
    error.message.includes("Missing required parameters: edits")
  ) {
    return "mechanical_edit_failure";
  }
  if (error.message.includes(EDIT_MISMATCH_MESSAGE)) {
    return "old_text_mismatch";
  }
  if (AMBIGUOUS_EDIT_PATTERNS.some((pattern) => pattern.test(error.message))) {
    return "ambiguous_old_text";
  }
  return undefined;
}

function appendMismatchHint(error: Error, currentContent: string): Error {
  const snippet =
    currentContent.length <= EDIT_MISMATCH_HINT_LIMIT
      ? currentContent
      : `${currentContent.slice(0, EDIT_MISMATCH_HINT_LIMIT)}\n... (truncated)`;
  const enhanced = new Error(
    `${error.message}\nCurrent file contents:\n${snippet}\nInspect the surrounding context and use a unique oldText anchor.`,
  );
  enhanced.stack = error.stack;
  return enhanced;
}

async function recordEditFailureSignal(params: {
  routeHealth?: EditToolRecoveryOptions["routeHealth"];
  absolutePath?: string;
  failureKind: "old_text_mismatch" | "ambiguous_old_text" | "mechanical_edit_failure";
}) {
  if (!params.routeHealth?.childSessionKey) {
    return;
  }
  await recordChildRouteEditFailure({
    childSessionKey: params.routeHealth.childSessionKey,
    runId: params.routeHealth.runId,
    ...(params.absolutePath ? { filePath: params.absolutePath } : {}),
    toolKind: "edit",
    failureKind: params.failureKind,
  });
}

async function recordEditSuccessSignal(params: {
  routeHealth?: EditToolRecoveryOptions["routeHealth"];
  absolutePath?: string;
}) {
  if (!params.routeHealth?.childSessionKey) {
    return;
  }
  await recordChildRouteEditSuccess({
    childSessionKey: params.routeHealth.childSessionKey,
    runId: params.routeHealth.runId,
    ...(params.absolutePath ? { filePath: params.absolutePath } : {}),
    toolKind: "edit",
  });
}

/**
 * Recover from two edit-tool failure classes without changing edit semantics:
 * - exact-match mismatch errors become actionable by including current file contents
 * - post-write throws are converted back to success only if the file actually changed
 */
export function wrapEditToolWithRecovery(
  base: AnyAgentTool,
  options: EditToolRecoveryOptions,
): AnyAgentTool {
  return {
    ...base,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ) => {
      const { pathParam, edits } = readEditToolParams(params);
      const absolutePath =
        typeof pathParam === "string" ? resolveEditPath(options.root, pathParam) : undefined;
      let originalContent: string | undefined;

      if (absolutePath && edits.length > 0) {
        try {
          originalContent = await options.readFile(absolutePath);
        } catch {
          // Best-effort snapshot only; recovery should still proceed without it.
        }
      }

      try {
        const result = await base.execute(toolCallId, params, signal, onUpdate);
        if (absolutePath && edits.length > 0) {
          await recordEditSuccessSignal({
            routeHealth: options.routeHealth,
            absolutePath,
          });
        }
        return result;
      } catch (err) {
        let currentContent: string | undefined;
        if (absolutePath) {
          try {
            currentContent = await options.readFile(absolutePath);
          } catch {
            // Fall through to the original error if readback fails.
          }
        }

        if (absolutePath && typeof currentContent === "string" && edits.length > 0) {
          if (
            didEditLikelyApply({
              originalContent,
              currentContent,
              edits,
            })
          ) {
            await recordEditSuccessSignal({
              routeHealth: options.routeHealth,
              absolutePath,
            });
            return buildEditSuccessResult(pathParam ?? absolutePath, edits.length);
          }
        }

        const failureKind = classifyMechanicalEditFailure({
          error: err,
          currentContent,
          edits,
        });
        if (failureKind) {
          await recordEditFailureSignal({
            routeHealth: options.routeHealth,
            absolutePath,
            failureKind,
          });
        }

        if (
          typeof currentContent === "string" &&
          err instanceof Error &&
          shouldAddMismatchHint(err)
        ) {
          throw appendMismatchHint(err, currentContent);
        }

        throw err;
      }
    },
  };
}
