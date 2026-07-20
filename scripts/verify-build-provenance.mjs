#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { verifyBuildProvenance } from "./lib/build-provenance.mjs";

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export { verifyBuildProvenance };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const rootDir = path.resolve(readArg("--root") ?? process.cwd());
    const manifest = verifyBuildProvenance({
      rootDir,
      manifestPath: readArg("--manifest"),
      sourceRoot: readArg("--source-root"),
      artifactRoot: readArg("--artifact-root"),
      validatorRoot: readArg("--validator-root"),
      sourceMapRoot: readArg("--source-map-root"),
      expectedRevision: readArg("--expected-revision") ?? process.env.OPENCLAW_SOURCE_REVISION,
      expectedRetainedArtifactUri: readArg("--expected-retained-artifact-uri"),
      requireRetainedSourceMaps:
        process.argv.includes("--require-retained-source-maps") ||
        process.env.OPENCLAW_REQUIRE_SOURCE_REVISION === "1",
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        sourceRevision: manifest.sourceRevision,
        manifestDigest: manifest.manifestDigest,
        retainedArtifact: manifest.sourceMaps.retainedArtifact,
      })}\n`,
    );
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
