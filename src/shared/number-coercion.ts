export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const MAX_TIMER_TIMEOUT_MS = 2_147_483_647;

export function resolvePositiveTimerTimeoutMs(value: unknown, fallback: number): number {
  const candidate = asFiniteNumber(value) ?? asFiniteNumber(fallback) ?? 1;
  return Math.max(1, Math.min(Math.floor(candidate), MAX_TIMER_TIMEOUT_MS));
}
