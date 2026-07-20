export function resolveGitHead(params?: {
  cwd?: string;
  spawnSync?: (
    cmd: string,
    args: string[],
    options: unknown,
  ) => { status: number | null; stdout?: string | null };
}): string | null;

export function writeBuildStamp(params?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fs?: {
    mkdirSync(path: string, options?: { recursive?: boolean }): void;
    writeFileSync(path: string, data: string, encoding?: string): void;
  };
  now?: () => number;
  resolveSourceRevision?: (params: { cwd: string }) => string | null;
  spawnSync?: (
    cmd: string,
    args: string[],
    options: unknown,
  ) => { status: number | null; stdout?: string | null };
}): string;
