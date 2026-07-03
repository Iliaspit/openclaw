import { existsSync } from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { execFileUtf8 } from "../../daemon/exec-file.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { CATALOG_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, jsonResult, readStringArrayParam } from "./common.js";

const CATALOG_SUMMARIZER_MODES = ["none", "mock", "cloud", "local", "auto"] as const;
const CATALOG_SCRIPT_RELATIVE_PATH = path.join("scripts", "openclaw-catalog", "catalog.mjs");
const CATALOG_TOOL_TIMEOUT_MS = 15_000;
const CATALOG_TOOL_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const CatalogToolSchema = Type.Object({
  paths: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description: "Repo-relative paths to inspect.",
  }),
  summarizer: optionalStringEnum(CATALOG_SUMMARIZER_MODES, {
    description: 'Optional summarizer override ("none", "mock", "cloud", "local", or "auto").',
  }),
});

function resolveCatalogScriptPath(workspaceDir: string): string {
  return path.join(workspaceDir, CATALOG_SCRIPT_RELATIVE_PATH);
}

function readOptionalSummarizerParam(
  params: Record<string, unknown>,
): (typeof CATALOG_SUMMARIZER_MODES)[number] | undefined {
  const raw = params.summarizer;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    throw new ToolInputError("summarizer must be one of none, mock, cloud, local, or auto");
  }
  const value = raw.trim();
  if (!value) {
    return undefined;
  }
  if (!CATALOG_SUMMARIZER_MODES.includes(value as (typeof CATALOG_SUMMARIZER_MODES)[number])) {
    throw new ToolInputError("summarizer must be one of none, mock, cloud, local, or auto");
  }
  return value as (typeof CATALOG_SUMMARIZER_MODES)[number];
}

export function createCatalogTool(options?: { workspaceDir?: string }): AnyAgentTool | null {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  const scriptPath = resolveCatalogScriptPath(workspaceDir);
  if (!existsSync(scriptPath)) {
    return null;
  }

  return {
    name: "catalog",
    label: "catalog",
    displaySummary: CATALOG_TOOL_DISPLAY_SUMMARY,
    description:
      "Inspect repo files with cached structural and summary metadata from the workspace catalog.",
    parameters: CatalogToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const paths = readStringArrayParam(params, "paths", {
        required: true,
        label: "paths",
      });
      const summarizer = readOptionalSummarizerParam(params);

      const result = await execFileUtf8(
        process.execPath,
        [CATALOG_SCRIPT_RELATIVE_PATH],
        {
          cwd: workspaceDir,
          timeout: CATALOG_TOOL_TIMEOUT_MS,
          maxBuffer: CATALOG_TOOL_MAX_BUFFER_BYTES,
          input: JSON.stringify({
            repo: workspaceDir,
            paths,
            ...(summarizer ? { summarizer } : {}),
          }),
        },
      );

      const stdout = result.stdout.trim();
      const stderr = result.stderr.trim();
      if (result.code !== 0) {
        return jsonResult({
          status: "error",
          error: stderr || `catalog CLI exited with code ${result.code}`,
          exitCode: result.code,
          ...(stdout ? { stdout } : {}),
        });
      }

      if (!stdout) {
        return jsonResult({
          status: "error",
          error: "catalog CLI produced no output.",
          ...(stderr ? { stderr } : {}),
        });
      }

      try {
        return jsonResult(JSON.parse(stdout));
      } catch (error) {
        return jsonResult({
          status: "error",
          error:
            error instanceof Error
              ? `catalog CLI returned invalid JSON: ${error.message}`
              : "catalog CLI returned invalid JSON.",
          stdout,
          ...(stderr ? { stderr } : {}),
        });
      }
    },
  };
}

export const __testing = {
  CATALOG_SCRIPT_RELATIVE_PATH,
  CATALOG_SUMMARIZER_MODES,
  readOptionalSummarizerParam,
  resolveCatalogScriptPath,
};
