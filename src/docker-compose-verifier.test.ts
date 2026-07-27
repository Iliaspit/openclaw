import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("guarded verifier OCI Compose topology", () => {
  it("gives the Gateway only the live read-only workspace and exact OCI identity", async () => {
    const compose = parse(
      await readFile(resolve(repoRoot, "docker-compose.verifier.yml"), "utf8"),
    ) as {
      services: Record<
        string,
        {
          environment?: Record<string, string>;
          volumes?: Array<{ type: string; source: string; target: string; read_only?: boolean }>;
        }
      >;
    };
    const gateway = compose.services["openclaw-gateway"];
    if (!gateway) {
      throw new Error("Guarded verifier Gateway overlay is missing.");
    }
    expect(gateway.volumes).toEqual([expect.objectContaining({ type: "bind", read_only: true })]);
    expect(gateway.environment).toMatchObject({
      OPENCLAW_VERIFIER_IMAGE_ID: "${OPENCLAW_VERIFIER_IMAGE_ID:?set OPENCLAW_VERIFIER_IMAGE_ID}",
      OPENCLAW_VERIFIER_ARTIFACT_DIGEST:
        "${OPENCLAW_VERIFIER_ARTIFACT_DIGEST:?set OPENCLAW_VERIFIER_ARTIFACT_DIGEST}",
    });
    expect(JSON.stringify(compose)).not.toContain("docker.sock");
    expect(JSON.stringify(compose)).not.toContain("type: volume");
  });

  it("builds dependencies and browsers into fixed OCI subpaths", async () => {
    const dockerfile = await readFile(resolve(repoRoot, "Dockerfile.sandbox-verifier"), "utf8");
    expect(dockerfile).toContain("yarn install --immutable");
    expect(dockerfile).toContain("yarn exec playwright install chromium");
    expect(dockerfile).toContain("/opt/openclaw-verifier/dependencies");
    expect(dockerfile).toContain("/opt/openclaw-verifier/browsers");
  });
});
