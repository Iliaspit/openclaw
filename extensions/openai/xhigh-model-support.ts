/**
 * OpenClaw gates `thinking: "xhigh"` with `supportsXHighThinking` before hitting
 * providers. Model ids evolve faster than hand-maintained allowlists; treat
 * OpenAI / Codex–family ids that typically ship extended reasoning as xhigh-capable.
 */
export function supportsOpenAiFamilyXHighModelId(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  if (!lower) {
    return false;
  }
  return (
    lower.startsWith("gpt-5") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    lower.includes("codex")
  );
}
