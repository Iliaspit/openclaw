import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";

export type ExecResult = { stdout: string; stderr: string; code: number };
type ExecFileUtf8Options = Omit<ExecFileOptionsWithStringEncoding, "encoding"> & {
  input?: string;
};

export async function execFileUtf8(
  command: string,
  args: string[],
  options: ExecFileUtf8Options = {},
): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve) => {
    const { input, ...execOptions } = options;
    const child = execFile(command, args, { ...execOptions, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) {
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: 0,
        });
        return;
      }

      const e = error as { code?: unknown; message?: unknown };
      const stderrText = stderr ?? "";
      resolve({
        stdout: stdout ?? "",
        stderr:
          stderrText ||
          (typeof e.message === "string" ? e.message : typeof error === "string" ? error : ""),
        code: typeof e.code === "number" ? e.code : 1,
      });
    });

    if (child.stdin) {
      child.stdin.end(input ?? "");
    }
  });
}
