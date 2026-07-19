import { copyFileSync, existsSync } from "node:fs";
import { resolveTaskRegistrySqlitePath } from "../tasks/task-registry.paths.js";
import {
  checkTaskRegistrySqliteIntegrity,
  reindexTaskRegistrySqlite,
} from "../tasks/task-registry.store.sqlite.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

type DoctorPrompterLike = {
  confirmRuntimeRepair: (params: { message: string; initialValue?: boolean }) => Promise<boolean>;
  note?: typeof note;
};

const MAX_ISSUE_LINES = 5;
const SIDECAR_SUFFIXES = ["", "-wal", "-shm"] as const;

function isIndexOnlyIntegrityIssue(issue: string): boolean {
  return /\bindex\b/i.test(issue);
}

function backupTaskRegistrySqliteFiles(sqlitePath: string): string[] {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backedUp: string[] = [];
  for (const suffix of SIDECAR_SUFFIXES) {
    const candidate = `${sqlitePath}${suffix}`;
    if (!existsSync(candidate)) {
      continue;
    }
    const backupPath = `${candidate}.bak.${timestamp}`;
    copyFileSync(candidate, backupPath);
    backedUp.push(backupPath);
  }
  return backedUp;
}

export async function noteTaskStoreHealth(prompter: DoctorPrompterLike): Promise<void> {
  const sqlitePath = resolveTaskRegistrySqlitePath(process.env);
  const noteFn = prompter.note ?? note;
  const displayPath = shortenHomePath(sqlitePath);

  let report: ReturnType<typeof checkTaskRegistrySqliteIntegrity>;
  try {
    report = checkTaskRegistrySqliteIntegrity();
  } catch (err) {
    noteFn(
      `- Failed to check task registry integrity (${displayPath}): ${String(err)}`,
      "Task store",
    );
    return;
  }

  if (!report.exists || report.ok) {
    return;
  }

  const indexOnly = report.issues.every(isIndexOnlyIntegrityIssue);
  const warnings = [
    `- CRITICAL: task registry database is corrupted (${displayPath}).`,
    "  Symptom: subagent/task spawns can silently fail to register or restore, orphaning child runs.",
    ...report.issues.slice(0, MAX_ISSUE_LINES).map((issue) => `  - ${issue}`),
  ];
  if (report.issues.length > MAX_ISSUE_LINES) {
    warnings.push(`  - and ${report.issues.length - MAX_ISSUE_LINES} more`);
  }

  if (!indexOnly) {
    warnings.push(
      "  This looks like structural (not index-only) corruption, so doctor will not attempt an automatic repair.",
      `  Stop the gateway, back up ${displayPath} (plus any -wal/-shm sidecars), then recover into a fresh database with SQLite's .recover command.`,
    );
    noteFn(warnings.join("\n"), "Task store");
    return;
  }

  warnings.push(
    "  This looks like index-only corruption, which REINDEX can usually repair without touching row data.",
  );
  noteFn(warnings.join("\n"), "Task store");

  const repair = await prompter.confirmRuntimeRepair({
    message: `Back up and reindex the task registry database (${displayPath})?`,
    initialValue: false,
  });
  if (!repair) {
    return;
  }

  try {
    const backedUp = backupTaskRegistrySqliteFiles(sqlitePath);
    reindexTaskRegistrySqlite();
    const verify = checkTaskRegistrySqliteIntegrity();
    const backupNote =
      backedUp.length > 0
        ? `Backed up ${backedUp.map((path) => shortenHomePath(path)).join(", ")}. `
        : "";
    if (verify.ok) {
      noteFn(
        `- ${backupNote}Reindexed ${displayPath} and verified integrity_check now reports ok. ` +
          "A running gateway that hit this corruption at startup and hasn't registered any tasks " +
          "since will pick up the repair automatically within about 30 seconds; otherwise restart " +
          "the gateway to pick up the repaired task registry.",
        "Task store",
      );
    } else {
      noteFn(
        `- ${backupNote}Reindexed ${displayPath} but integrity_check still reports issues. Manual .recover into a fresh database is required.`,
        "Task store",
      );
    }
  } catch (err) {
    noteFn(`- Failed to reindex ${displayPath}: ${String(err)}`, "Task store");
  }
}
