#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { writeBuildProvenance } from "./lib/build-provenance.mjs";

export { writeBuildProvenance };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    writeBuildProvenance();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
