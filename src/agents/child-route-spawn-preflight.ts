import {
  readActiveChildRouteAuthBlockers,
  readActiveChildRouteAuthBlockersForRoute,
  type ChildRouteActiveAuthBlockerSummary,
  type ChildRouteProviderContext,
} from "./child-route-health.js";

export function authBlockersPreventFreshSpawn(
  blockers: ChildRouteActiveAuthBlockerSummary[],
): boolean {
  return blockers.some((blocker) => blocker.codes.includes("auth_profile_session_expired"));
}

export async function guardFreshChildSpawnAuth(
  provider: ChildRouteProviderContext,
  route?: {
    childSessionKey?: string;
    runId?: string;
    includeProviderDefaultCredentialBlockers?: boolean;
  },
): Promise<
  | { ok: true }
  | {
      ok: false;
      code: "auth_profile_session_expired" | "child_route_health_unavailable";
      error: string;
      retryable: boolean;
      authBlockers?: ChildRouteActiveAuthBlockerSummary[];
    }
> {
  const authBlockers = route
    ? await readActiveChildRouteAuthBlockersForRoute({
        provider,
        childSessionKey: route.childSessionKey,
        runId: route.runId,
        includeProviderDefaultCredentialBlockers: route.includeProviderDefaultCredentialBlockers,
      })
    : await readActiveChildRouteAuthBlockers(provider);
  if (!authBlockers.ok) {
    return {
      ok: false,
      code: "child_route_health_unavailable",
      error:
        "Auth route health is unavailable; do not spawn a fresh child until provider health is known.",
      retryable: authBlockers.retryable,
    };
  }
  if (authBlockersPreventFreshSpawn(authBlockers.blockers)) {
    return {
      ok: false,
      code: "auth_profile_session_expired",
      error:
        "Re-authenticate or select a healthy fallback provider profile before spawning a fresh child.",
      retryable: false,
      authBlockers: authBlockers.blockers,
    };
  }
  return { ok: true };
}
