import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { createCatalogTool } from "./tools/catalog-tool.js";

async function createCatalogWorkspace(scriptBody?: string): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-catalog-tool-"));
  const scriptPath = path.join(workspaceDir, "scripts", "openclaw-catalog", "catalog.mjs");
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(
    scriptPath,
    scriptBody ??
      [
        'import fs from "node:fs";',
        'const input = JSON.parse(fs.readFileSync(0, "utf8"));',
        "process.stdout.write(JSON.stringify({",
        "  files: input.paths.map((value) => ({ path: value })),",
        "  denied: [],",
        "  deniedDetail: [],",
        '  directoryRollup: { [input.paths[0] ?? "root"]: input.paths.length },',
        "  summarizerProvider: input.summarizer ?? null,",
        "  summarizerCostUsd: 0,",
        "  summarizerErrors: [],",
        '  catalogVersion: "test",',
        "}));",
      ].join("\n"),
    "utf8",
  );
  return workspaceDir;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("catalog tool registration", () => {
  it("returns null when the workspace does not expose the catalog CLI", () => {
    const tool = createCatalogTool({ workspaceDir: "/tmp/openclaw-missing-catalog" });
    expect(tool).toBeNull();
  });

  it("registers the catalog tool when enabled and the workspace script exists", async () => {
    const workspaceDir = await createCatalogWorkspace();
    tempDirs.push(workspaceDir);

    const tools = createOpenClawTools({
      workspaceDir,
      config: {
        tools: {
          catalog: { enabled: true },
        },
      } as OpenClawConfig,
      disablePluginTools: true,
    });

    expect(tools.map((tool) => tool.name)).toContain("catalog");
  });

  it("executes the workspace catalog CLI and returns parsed JSON", async () => {
    const workspaceDir = await createCatalogWorkspace();
    tempDirs.push(workspaceDir);

    const tool = createCatalogTool({ workspaceDir });
    expect(tool).toBeTruthy();

    const result = await tool!.execute("call-1", {
      paths: ["src/", "tests/"],
      summarizer: "auto",
    });
    const details = result.details as {
      files: Array<{ path: string }>;
      summarizerProvider: string | null;
      catalogVersion: string;
    };

    expect(details.files.map((entry) => entry.path)).toEqual(["src/", "tests/"]);
    expect(details.summarizerProvider).toBe("auto");
    expect(details.catalogVersion).toBe("test");
  });
});
