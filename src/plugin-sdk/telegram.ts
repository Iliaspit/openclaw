// Manual facade. Keep loader boundary explicit.
type FacadeModule = typeof import("@openclaw/telegram/contract-api.js");
import {
  createLazyFacadeArrayValue,
  loadBundledPluginPublicSurfaceModule,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "telegram",
    artifactBasename: "contract-api.js",
  });
}

async function loadSecurityAuditFacadeModule(): Promise<FacadeModule> {
  return await loadBundledPluginPublicSurfaceModule<FacadeModule>({
    dirName: "telegram",
    artifactBasename: "contract-api.js",
  });
}

export const parseTelegramTopicConversation: FacadeModule["parseTelegramTopicConversation"] = ((
  ...args
) =>
  loadFacadeModule().parseTelegramTopicConversation(
    ...args,
  )) as FacadeModule["parseTelegramTopicConversation"];

export const singleAccountKeysToMove: FacadeModule["singleAccountKeysToMove"] =
  createLazyFacadeArrayValue(() => loadFacadeModule().singleAccountKeysToMove);

export const collectTelegramSecurityAuditFindings: FacadeModule["collectTelegramSecurityAuditFindings"] =
  (async (...args) =>
    (await loadSecurityAuditFacadeModule()).collectTelegramSecurityAuditFindings(
      ...args,
    )) as FacadeModule["collectTelegramSecurityAuditFindings"];

export const mergeTelegramAccountConfig: FacadeModule["mergeTelegramAccountConfig"] = ((...args) =>
  loadFacadeModule().mergeTelegramAccountConfig(
    ...args,
  )) as FacadeModule["mergeTelegramAccountConfig"];
