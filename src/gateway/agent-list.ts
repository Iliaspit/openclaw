import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import type { SessionScope } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, normalizeMainKey } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export type GatewayAgentListRow = {
  id: string;
  name?: string;
};

function listExistingAgentIdsFromDisk(): string[] {
  const root = resolveStateDir();
  const agentsDir = path.join(root, "agents");
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => normalizeAgentId(entry.name))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listConfiguredAgentIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
  ids.add(defaultId);

  const listIdsInOrder: string[] = [];
  const listOrderSeen = new Set<string>();
  for (const entry of cfg.agents?.list ?? []) {
    if (!entry?.id) {
      continue;
    }
    const id = normalizeAgentId(entry.id);
    if (!id || listOrderSeen.has(id)) {
      continue;
    }
    listOrderSeen.add(id);
    listIdsInOrder.push(id);
    ids.add(id);
  }

  for (const id of listExistingAgentIdsFromDisk()) {
    ids.add(id);
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  const pushId = (id: string) => {
    if (!id || seen.has(id) || !ids.has(id)) {
      return;
    }
    seen.add(id);
    ordered.push(id);
  };

  const declaredIds = new Set(listIdsInOrder);
  if (!declaredIds.has(defaultId)) {
    pushId(defaultId);
  }
  for (const id of listIdsInOrder) {
    pushId(id);
  }

  const remainder = Array.from(ids)
    .filter((id) => !seen.has(id))
    .sort((a, b) => a.localeCompare(b));
  for (const id of remainder) {
    pushId(id);
  }

  return ordered;
}

export function listGatewayAgentsBasic(cfg: OpenClawConfig): {
  defaultId: string;
  mainKey: string;
  scope: SessionScope;
  agents: GatewayAgentListRow[];
} {
  const defaultId = normalizeAgentId(resolveDefaultAgentId(cfg));
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const configuredById = new Map<string, { name?: string }>();
  for (const entry of cfg.agents?.list ?? []) {
    if (!entry?.id) {
      continue;
    }
    configuredById.set(normalizeAgentId(entry.id), {
      name: normalizeOptionalString(entry.name),
    });
  }
  const explicitIds = new Set(
    (cfg.agents?.list ?? [])
      .map((entry) => (entry?.id ? normalizeAgentId(entry.id) : ""))
      .filter(Boolean),
  );
  const allowedIds = explicitIds.size > 0 ? new Set([...explicitIds, defaultId]) : null;
  let agentIds = listConfiguredAgentIds(cfg).filter((id) =>
    allowedIds ? allowedIds.has(id) : true,
  );
  if (mainKey && !agentIds.includes(mainKey) && (!allowedIds || allowedIds.has(mainKey))) {
    agentIds = [...agentIds, mainKey];
  }
  const agents = agentIds.map((id) => {
    const meta = configuredById.get(id);
    return {
      id,
      name: meta?.name,
    };
  });
  return { defaultId, mainKey, scope, agents };
}
