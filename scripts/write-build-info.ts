import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildSourceRevision } from "./lib/build-provenance.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const pkgPath = path.join(rootDir, "package.json");

const readPackageVersion = () => {
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
};

const version = readPackageVersion();
const commit = resolveBuildSourceRevision({ cwd: rootDir });

const buildInfo = {
  version,
  commit,
};

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
