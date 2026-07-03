// Manual facade. Keep loader boundary explicit.
import {
  createLazyFacadeValue as createLazyFacadeRuntimeValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-runtime.js";

type FacadeModule = typeof import("@openclaw/ollama/runtime-api.js");

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "ollama",
    artifactBasename: "runtime-api.js",
  });
}

// Keep defaults inline so importing the runtime facade stays cold until a
// helper is actually used. These values are part of the public Ollama contract.
export const OLLAMA_NATIVE_BASE_URL: FacadeModule["OLLAMA_NATIVE_BASE_URL"] =
  "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_EMBEDDING_MODEL: FacadeModule["DEFAULT_OLLAMA_EMBEDDING_MODEL"] =
  "nomic-embed-text";

export const buildAssistantMessage: FacadeModule["buildAssistantMessage"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "buildAssistantMessage");
export const buildOllamaChatRequest: FacadeModule["buildOllamaChatRequest"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "buildOllamaChatRequest");
export const convertToOllamaMessages: FacadeModule["convertToOllamaMessages"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "convertToOllamaMessages");
export const createConfiguredOllamaCompatNumCtxWrapper: FacadeModule["createConfiguredOllamaCompatNumCtxWrapper"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "createConfiguredOllamaCompatNumCtxWrapper");
export const createConfiguredOllamaCompatStreamWrapper: FacadeModule["createConfiguredOllamaCompatStreamWrapper"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "createConfiguredOllamaCompatStreamWrapper");
export const createConfiguredOllamaStreamFn: FacadeModule["createConfiguredOllamaStreamFn"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "createConfiguredOllamaStreamFn");
export const createOllamaStreamFn: FacadeModule["createOllamaStreamFn"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "createOllamaStreamFn");
export const createOllamaEmbeddingProvider: FacadeModule["createOllamaEmbeddingProvider"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "createOllamaEmbeddingProvider");
export const isOllamaCompatProvider: FacadeModule["isOllamaCompatProvider"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "isOllamaCompatProvider");
export const parseNdjsonStream: FacadeModule["parseNdjsonStream"] = createLazyFacadeRuntimeValue(
  loadFacadeModule,
  "parseNdjsonStream",
);
export const resolveOllamaBaseUrlForRun: FacadeModule["resolveOllamaBaseUrlForRun"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "resolveOllamaBaseUrlForRun");
export const resolveOllamaCompatNumCtxEnabled: FacadeModule["resolveOllamaCompatNumCtxEnabled"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "resolveOllamaCompatNumCtxEnabled");
export const shouldInjectOllamaCompatNumCtx: FacadeModule["shouldInjectOllamaCompatNumCtx"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "shouldInjectOllamaCompatNumCtx");
export const wrapOllamaCompatNumCtx: FacadeModule["wrapOllamaCompatNumCtx"] =
  createLazyFacadeRuntimeValue(loadFacadeModule, "wrapOllamaCompatNumCtx");

export type {
  OllamaEmbeddingClient,
  OllamaEmbeddingProvider,
} from "@openclaw/ollama/runtime-api.js";
