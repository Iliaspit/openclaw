#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolveBuildSourceRevision } from "./lib/build-provenance.mjs";

export function resolveGitHead(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const spawnSyncImpl = params.spawnSync ?? spawnSync;
  try {
    const result = spawnSyncImpl("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) {
      return null;
    }
    const head = (result.stdout ?? "").trim();
    return head || null;
  } catch {
    return null;
  }
}

export function writeBuildStamp(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const now = params.now ?? Date.now;
  const env = params.env ?? process.env;
  const distRoot = path.join(cwd, "dist");
  const buildStampPath = path.join(distRoot, ".buildstamp");
  const requiresProvenanceRevision =
    env.OPENCLAW_SOURCE_REVISION !== undefined || env.OPENCLAW_REQUIRE_SOURCE_REVISION === "1";
  const head = params.resolveSourceRevision
    ? params.resolveSourceRevision({ cwd })
    : requiresProvenanceRevision
      ? resolveBuildSourceRevision({ cwd, env })
      : resolveGitHead({ cwd, spawnSync: params.spawnSync });

  fsImpl.mkdirSync(distRoot, { recursive: true });
  fsImpl.writeFileSync(buildStampPath, `${JSON.stringify({ builtAt: now(), head })}\n`, "utf8");
  return buildStampPath;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    writeBuildStamp();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
