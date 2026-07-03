import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { ChildRouteProviderContext } from "./child-route-health.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  normalizeStoredOverrideModel,
  parseModelRef,
  resolveConfiguredModelRef,
  resolvePersistedSelectedModelRef,
} from "./model-selection.js";

export function resolveChildRouteProviderContextFromSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  entry?: Pick<
    SessionEntry,
    "providerOverride" | "modelOverride" | "modelProvider" | "model" | "authProfileOverride"
  >;
  requesterSessionKey?: string;
}): ChildRouteProviderContext {
  const defaultModel = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const normalizedSelection = normalizeStoredOverrideModel({
    providerOverride: params.entry?.providerOverride,
    modelOverride: params.entry?.modelOverride,
  });
  const persisted = resolvePersistedSelectedModelRef({
    defaultProvider: defaultModel.provider,
    runtimeProvider: params.entry?.modelProvider,
    runtimeModel: params.entry?.model,
    overrideProvider: normalizedSelection.providerOverride,
    overrideModel: normalizedSelection.modelOverride,
  });
  const provider: ChildRouteProviderContext = {
    providerId:
      persisted?.provider ??
      normalizedSelection.providerOverride ??
      normalizeOptionalString(params.entry?.providerOverride) ??
      defaultModel.provider,
    modelId: persisted?.model ?? defaultModel.model,
  };
  const authProfileKey = normalizeOptionalString(params.entry?.authProfileOverride);
  if (authProfileKey) {
    provider.authProfileKey = authProfileKey;
  }
  const requesterSessionKey = normalizeOptionalString(params.requesterSessionKey);
  if (requesterSessionKey) {
    provider.requesterSessionKey = requesterSessionKey;
  }
  return provider;
}

export function resolveChildRouteProviderContextForSpawn(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  requesterSessionKey?: string;
  modelRef?: string;
}): ChildRouteProviderContext {
  const provider = resolveChildRouteProviderContextFromSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    requesterSessionKey: params.requesterSessionKey,
  });
  const modelRef = normalizeOptionalString(params.modelRef);
  if (!modelRef) {
    return provider;
  }
  const parsed = parseModelRef(modelRef, provider.providerId ?? "");
  if (parsed) {
    provider.providerId = parsed.provider;
    provider.modelId = parsed.model;
    return provider;
  }
  const [providerId, modelId] = modelRef.split("/", 2);
  if (modelId) {
    provider.providerId = providerId;
    provider.modelId = modelId;
  } else {
    provider.modelId = modelRef;
  }
  return provider;
}
