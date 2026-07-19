// Real workspace contract for memory embedding providers and batch helpers.

export {
  getMemoryEmbeddingProvider,
  listRegisteredMemoryEmbeddingProviders,
  listMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviderAdapters,
} from "../plugins/memory-embedding-provider-runtime.js";
export type {
  MemoryEmbeddingBatchChunk,
  MemoryEmbeddingBatchOptions,
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProviderCreateResult,
  MemoryEmbeddingProviderRuntime,
} from "../plugins/memory-embedding-providers.js";
export { createLocalEmbeddingProvider, DEFAULT_LOCAL_MODEL } from "./host/embeddings.js";
export { applyEmbeddingBatchOutputLine } from "./host/batch-output.js";
export type { EmbeddingBatchOutputLine as ProviderBatchOutputLine } from "./host/batch-output.js";
export type { EmbeddingBatchStatus } from "./host/batch-provider-common.js";
export { EMBEDDING_BATCH_ENDPOINT } from "./host/batch-provider-common.js";
export { buildEmbeddingBatchGroupOptions, runEmbeddingBatchGroups } from "./host/batch-runner.js";
export type { EmbeddingBatchExecutionParams } from "./host/batch-runner.js";
export { extractBatchErrorMessage, formatUnavailableBatchError } from "./host/batch-error-utils.js";
export {
  resolveBatchCompletionFromStatus,
  resolveCompletedBatchResult,
  throwIfBatchTerminalFailure,
} from "./host/batch-status.js";
export type { BatchCompletionResult } from "./host/batch-status.js";
export { buildBatchHeaders, normalizeBatchBaseUrl } from "./host/batch-utils.js";
export { postJsonWithRetry } from "./host/batch-http.js";
export { uploadBatchJsonlFile } from "./host/batch-upload.js";
export { fetchRemoteEmbeddingVectors } from "./host/embeddings-remote-fetch.js";
export {
  createRemoteEmbeddingProvider,
  resolveRemoteEmbeddingClient,
} from "./host/embeddings-remote-provider.js";
export { resolveRemoteEmbeddingBearerClient } from "./host/embeddings-remote-client.js";
export { normalizeEmbeddingModelWithPrefixes } from "./host/embeddings-model-normalize.js";
export {
  createGitHubCopilotEmbeddingProvider,
  type GitHubCopilotEmbeddingClient,
} from "./host/embeddings-github-copilot.js";
export { debugEmbeddingsLog } from "./host/embeddings-debug.js";
export {
  isMissingEmbeddingApiKeyError,
  mapBatchEmbeddingsByIndex,
  sanitizeEmbeddingCacheHeaders,
} from "./host/embedding-provider-adapter-utils.js";
export { sanitizeAndNormalizeEmbedding } from "./host/embedding-vectors.js";
export { enforceEmbeddingMaxInputTokens } from "./host/embedding-chunk-limits.js";
export {
  estimateStructuredEmbeddingInputBytes,
  estimateUtf8Bytes,
} from "./host/embedding-input-limits.js";
export { hasNonTextEmbeddingParts, type EmbeddingInput } from "./host/embedding-inputs.js";
export {
  buildCaseInsensitiveExtensionGlob,
  classifyMemoryMultimodalPath,
  getMemoryMultimodalExtensions,
} from "./host/multimodal.js";
export { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "./host/remote-http.js";
