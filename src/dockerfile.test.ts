import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_PLUGIN_ROOT_DIR } from "../test/helpers/bundled-plugin-paths.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dockerfilePath = join(repoRoot, "Dockerfile");
const verifierDockerfilePath = join(repoRoot, "Dockerfile.sandbox-verifier");

function collapseDockerContinuations(dockerfile: string): string {
  return dockerfile.replace(/\\\r?\n[ \t]*/g, " ");
}

describe("Dockerfile", () => {
  it("uses shared multi-arch base image refs for all root Node stages", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_BOOKWORM_IMAGE="node:24-bookworm@sha256:3a09aa6354567619221ef6c45a5051b671f953f0a1924d1f819ffb236e520e6b"',
    );
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE="node:24-bookworm-slim@sha256:e8e2e91b1378f83c5b2dd15f0247f34110e2fe895f6ca7719dbb780f929368eb"',
    );
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS ext-deps");
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS build");
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS base-default");
    expect(dockerfile).toContain("FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-slim");
    expect(dockerfile).toContain("current multi-arch manifest list entry");
    expect(dockerfile).not.toContain("current amd64 entry");
  });

  it("installs optional browser dependencies after pnpm install", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
    const browserArgIndex = dockerfile.indexOf("ARG OPENCLAW_INSTALL_BROWSER");

    expect(installIndex).toBeGreaterThan(-1);
    expect(browserArgIndex).toBeGreaterThan(-1);
    expect(browserArgIndex).toBeGreaterThan(installIndex);
    expect(dockerfile.match(/ARG OPENCLAW_INSTALL_BROWSER="1"/g)).toHaveLength(2);
    expect(dockerfile).toContain(
      "node /app/node_modules/playwright-core/cli.js install --with-deps chromium",
    );
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends xvfb");
  });

  it("verifies matrix-sdk-crypto native addons without hardcoded pnpm virtual-store paths", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("Verifying critical native addons");
    expect(dockerfile).toContain('find /app/node_modules -name "matrix-sdk-crypto*.node"');
    expect(dockerfile).not.toMatch(
      /ADDON_DIR=.*node_modules\/\.pnpm\/@matrix-org\+matrix-sdk-crypto-nodejs@/,
    );
  });

  it("prunes runtime dependencies after the build stage", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("FROM build AS runtime-assets");
    expect(dockerfile).toContain("ARG OPENCLAW_EXTENSIONS");
    expect(dockerfile).toContain("ARG OPENCLAW_BUNDLED_PLUGIN_DIR");
    expect(dockerfile).toContain("pnpm-workspace.runtime.yaml");
    expect(dockerfile).toContain("  - ui\\n");
    expect(dockerfile).toContain("CI=true NPM_CONFIG_FROZEN_LOCKFILE=false pnpm prune --prod");
    expect(dockerfile).toContain("prune must not rediscover unrelated workspaces");
    expect(dockerfile).not.toContain(
      `npm install --prefix "${BUNDLED_PLUGIN_ROOT_DIR}/$ext" --omit=dev --silent`,
    );
    expect(dockerfile).toContain(
      "COPY --from=runtime-assets --chown=node:node /app/node_modules ./node_modules",
    );
  });

  it("does not override bundled plugin discovery in runtime images", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    expect(dockerfile).toContain(`ARG OPENCLAW_BUNDLED_PLUGIN_DIR=${BUNDLED_PLUGIN_ROOT_DIR}`);
    expect(dockerfile).not.toMatch(/^\s*ENV\b[^\n]*\bOPENCLAW_BUNDLED_PLUGINS_DIR\b/m);
  });

  it("normalizes plugin and agent paths permissions in image layers", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain(
      "RUN for dir in /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} /app/.agent /app/.agents; do \\",
    );
    expect(dockerfile).toContain('find "$dir" -type d -exec chmod 755 {} +');
    expect(dockerfile).toContain('find "$dir" -type f -exec chmod 644 {} +');
  });

  it("Docker GPG fingerprint awk uses correct quoting for OPENCLAW_SANDBOX=1 build", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain('== "fpr" {');
    expect(dockerfile).not.toContain('\\"fpr\\"');
  });

  it("keeps runtime pnpm available", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("ENV COREPACK_HOME=/usr/local/share/corepack");
    expect(dockerfile).toContain(
      'corepack prepare "$(node -p "require(\'./package.json\').packageManager")" --activate',
    );
  });

  it("keeps the guarded verifier OCI artifact offline-ready without Docker tooling", async () => {
    const dockerfile = await readFile(verifierDockerfilePath, "utf8");
    expect(dockerfile).toContain(
      'ARG OPENCLAW_NODE_BOOKWORM_IMAGE="node:24-bookworm@sha256:3a09aa6354567619221ef6c45a5051b671f953f0a1924d1f819ffb236e520e6b"',
    );
    expect(dockerfile).toContain("ARG OPENCLAW_VERIFIER_PACKAGE_MANAGER");
    expect(dockerfile).toContain(
      'corepack prepare "${OPENCLAW_VERIFIER_PACKAGE_MANAGER}" --activate',
    );
    expect(dockerfile).toContain('test -x "$(command -v yarn)"');
    expect(dockerfile).toContain(
      'test "$(yarn --version)" = "${OPENCLAW_VERIFIER_PACKAGE_MANAGER#yarn@}"',
    );
    expect(dockerfile).toContain("grep -Eq '^yarn@");
    expect(dockerfile).not.toContain("pnpm|npm|bun");
    expect(dockerfile).toContain('org.opencontainers.image.revision="${OPENCLAW_SOURCE_REVISION}"');
    expect(dockerfile).toContain("ARG OPENCLAW_RUNTIME_IMAGE_ID");
    expect(dockerfile).toContain(
      'ai.openclaw.verifier.runtime-image="${OPENCLAW_RUNTIME_IMAGE_ID}"',
    );
    expect(dockerfile).toContain('ai.openclaw.sandbox.contract="guarded-verifier-candidate-v1"');
    expect(dockerfile).toContain("chromium");
    expect(dockerfile).toContain("-perm /111 -print -quit");
    expect(dockerfile).toContain("PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright");
    expect(dockerfile).not.toContain("apt-get upgrade");
    expect(dockerfile).toContain("FROM verifier-base AS verifier-builder");
    expect(dockerfile).toContain(
      "install -d -o node -g node -m 0755 /build/workspace /build/browsers",
    );
    expect(dockerfile).toContain("COPY --chown=node:node . .");
    expect(dockerfile).toContain("YARN_NODE_LINKER=node-modules yarn install --immutable");
    expect(dockerfile).toContain(
      "YARN_NODE_LINKER=node-modules PLAYWRIGHT_BROWSERS_PATH=/build/browsers",
    );
    expect(dockerfile).toContain("test -d /build/workspace/node_modules");
    expect(dockerfile).toContain("/opt/openclaw-verifier/dependencies");
    expect(dockerfile).not.toContain("docker-ce-cli");
    expect(dockerfile).toContain("/opt/openclaw/openclaw.mjs");
  });
});
