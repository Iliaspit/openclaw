import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "../plugins/bundled-compat.js";
import { __testing as loaderTesting } from "../plugins/loader.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";
import { withMediaFixture } from "./runner.test-utils.js";

const baseCatalog = [
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    input: ["text", "image"] as const,
  },
];
let catalog = [...baseCatalog];
const plantedVisionSentinel = "PLANTED_VISION_DESC_zq7x";

const loadModelCatalog = vi.hoisted(() => vi.fn(async () => catalog));
const modelAuthMocks = vi.hoisted(() => ({
  hasAvailableAuthForProvider: vi.fn(() => true),
  resolveApiKeyForProvider: vi.fn(async () => ({
    apiKey: "test-key",
    source: "test",
    mode: "api-key",
  })),
  requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? "test-key"),
}));

vi.mock("../agents/model-auth.js", () => ({
  hasAvailableAuthForProvider: modelAuthMocks.hasAvailableAuthForProvider,
  resolveApiKeyForProvider: modelAuthMocks.resolveApiKeyForProvider,
  requireApiKey: modelAuthMocks.requireApiKey,
}));

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const runtime =
    await vi.importActual<typeof import("../plugins/runtime.js")>("../plugins/runtime.js");
  return {
    resolvePluginCapabilityProviders: ({ key }: { key: string }) =>
      key === "mediaUnderstandingProviders"
        ? (runtime
            .getActivePluginRegistry()
            ?.mediaUnderstandingProviders.map((entry) => entry.provider) ?? [])
        : [],
  };
});

vi.mock("../agents/model-catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/model-catalog.js")>(
    "../agents/model-catalog.js",
  );
  return {
    ...actual,
    loadModelCatalog,
  };
});

let buildProviderRegistry: typeof import("./runner.js").buildProviderRegistry;
let applyMediaUnderstanding: typeof import("./apply.js").applyMediaUnderstanding;
let resolveAutoImageModel: typeof import("./runner.js").resolveAutoImageModel;
let runCapability: typeof import("./runner.js").runCapability;

function setCompatibleActiveMediaUnderstandingRegistry(
  pluginRegistry: ReturnType<typeof createEmptyPluginRegistry>,
  cfg: OpenClawConfig,
) {
  const pluginIds = loadPluginManifestRegistry({
    config: cfg,
    env: process.env,
  })
    .plugins.filter(
      (plugin) =>
        plugin.origin === "bundled" &&
        (plugin.contracts?.mediaUnderstandingProviders?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  const compatibleConfig = withBundledPluginVitestCompat({
    config: withBundledPluginEnablementCompat({
      config: withBundledPluginAllowlistCompat({
        config: cfg,
        pluginIds,
      }),
      pluginIds,
    }),
    pluginIds,
    env: process.env,
  });
  const { cacheKey } = loaderTesting.resolvePluginLoadCacheContext({
    config: compatibleConfig,
    env: process.env,
  });
  setActivePluginRegistry(pluginRegistry, cacheKey);
}

describe("runCapability image skip", () => {
  beforeAll(async () => {
    vi.doMock("../agents/model-catalog.js", async () => {
      const actual = await vi.importActual<typeof import("../agents/model-catalog.js")>(
        "../agents/model-catalog.js",
      );
      return {
        ...actual,
        loadModelCatalog,
      };
    });
    ({ buildProviderRegistry, resolveAutoImageModel, runCapability } = await import("./runner.js"));
    ({ applyMediaUnderstanding } = await import("./apply.js"));
  });

  beforeEach(() => {
    catalog = [...baseCatalog];
    loadModelCatalog.mockClear();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });

  it("skips image understanding when the active model supports vision", async () => {
    const ctx: MsgContext = { MediaPath: "/tmp/image.png", MediaType: "image/png" };
    const media = normalizeMediaAttachments(ctx);
    const cache = createMediaAttachmentCache(media);
    const cfg = {} as OpenClawConfig;

    try {
      const result = await runCapability({
        capability: "image",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry: buildProviderRegistry(),
        activeModel: { provider: "openai", model: "gpt-4.1" },
      });

      expect(result.outputs).toHaveLength(0);
      expect(result.decision.outcome).toBe("skipped");
      expect(result.decision.attachments).toHaveLength(1);
      expect(result.decision.attachments[0]?.attachmentIndex).toBe(0);
      expect(result.decision.attachments[0]?.attempts[0]?.outcome).toBe("skipped");
      expect(result.decision.attachments[0]?.attempts[0]?.reason).toBe(
        "primary model supports vision natively",
      );
    } finally {
      await cache.cleanup();
    }
  });

  it("skips agents.defaults.imageModel fallback when the active model supports vision", async () => {
    await withMediaFixture(
      {
        filePrefix: "openclaw-image-default-model-native-skip",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx }) => {
        let describeCalls = 0;
        const msgCtx = ctx as MsgContext;
        msgCtx.Body = "please inspect this image";
        const cfg = {
          agents: {
            defaults: {
              imageModel: { primary: "minimax/MiniMax-M3" },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await applyMediaUnderstanding({
          ctx: msgCtx,
          cfg,
          agentDir: "/tmp",
          providers: {
            minimax: {
              id: "minimax",
              capabilities: ["image"],
              describeImage: async (req) => {
                describeCalls += 1;
                return { text: plantedVisionSentinel, model: req.model };
              },
            },
          },
          activeModel: { provider: "openai", model: "gpt-4.1" },
        });

        const imageDecision = result.decisions.find((decision) => decision.capability === "image");
        const attempt = imageDecision?.attachments[0]?.attempts[0];
        expect(result.appliedImage).toBe(false);
        expect(imageDecision?.outcome).toBe("skipped");
        expect(attempt?.outcome).toBe("skipped");
        expect(attempt?.reason).toBe("primary model supports vision natively");
        expect(describeCalls).toBe(0);
        expect(msgCtx.Body).not.toContain(plantedVisionSentinel);
      },
    );
  });

  it("skips agents.defaults.imageModel fallback when MiniMax M3 supports vision", async () => {
    catalog = [
      ...baseCatalog,
      {
        id: "MiniMax-M3",
        name: "MiniMax M3",
        provider: "minimax",
        input: ["text", "image"] as const,
      },
    ];

    await withMediaFixture(
      {
        filePrefix: "openclaw-image-default-model-minimax-m3-native-skip",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx }) => {
        let describeCalls = 0;
        const msgCtx = ctx as MsgContext;
        msgCtx.Body = "please inspect this minimax image";
        const cfg = {
          agents: {
            defaults: {
              imageModel: { primary: "minimax/MiniMax-M3" },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await applyMediaUnderstanding({
          ctx: msgCtx,
          cfg,
          agentDir: "/tmp",
          providers: {
            minimax: {
              id: "minimax",
              capabilities: ["image"],
              describeImage: async (req) => {
                describeCalls += 1;
                return { text: plantedVisionSentinel, model: req.model };
              },
            },
          },
          activeModel: { provider: "minimax", model: "MiniMax-M3" },
        });

        const imageDecision = result.decisions.find((decision) => decision.capability === "image");
        const attempt = imageDecision?.attachments[0]?.attempts[0];
        expect(result.appliedImage).toBe(false);
        expect(imageDecision?.outcome).toBe("skipped");
        expect(attempt?.outcome).toBe("skipped");
        expect(attempt?.reason).toBe("primary model supports vision natively");
        expect(describeCalls).toBe(0);
        expect(msgCtx.Body).not.toContain(plantedVisionSentinel);
      },
    );
  });

  it("uses explicit media image models instead of native vision skip", async () => {
    await withMediaFixture(
      {
        filePrefix: "openclaw-image-explicit-vision",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx, media, cache }) => {
        const cfg = {} as OpenClawConfig;

        const result = await runCapability({
          capability: "image",
          cfg,
          ctx,
          attachments: cache,
          media,
          agentDir: "/tmp",
          providerRegistry: new Map([
            [
              "openrouter",
              {
                id: "openrouter",
                capabilities: ["image"],
                describeImage: async (req) => ({ text: "explicit ok", model: req.model }),
              },
            ],
          ]),
          config: {
            models: [{ provider: "openrouter", model: "google/gemini-2.5-flash" }],
          },
          activeModel: { provider: "openai", model: "gpt-4.1" },
        });

        expect(result.decision.outcome).toBe("success");
        expect(result.outputs[0]).toEqual({
          kind: "image.description",
          attachmentIndex: 0,
          provider: "openrouter",
          model: "google/gemini-2.5-flash",
          text: "explicit ok",
        });
      },
    );
  });

  it("keeps agents.defaults.imageModel available to exported auto image resolution", async () => {
    const cfg = {
      agents: {
        defaults: {
          imageModel: { primary: "openrouter/google/gemini-2.5-flash" },
        },
      },
    } as unknown as OpenClawConfig;

    await expect(
      resolveAutoImageModel({
        cfg,
        activeModel: { provider: "openai", model: "gpt-4.1" },
      }),
    ).resolves.toEqual({
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
    });
  });

  it("falls back from a MiniMax chat model to the provider image default", async () => {
    catalog = [
      {
        id: "MiniMax-M2.7",
        name: "MiniMax M2.7",
        provider: "minimax-portal",
        input: ["text", "image"] as const,
      },
      {
        id: "MiniMax-VL-01",
        name: "MiniMax VL 01",
        provider: "minimax-portal",
        input: ["text", "image"] as const,
      },
    ];
    const cfg = {
      models: {
        providers: {
          "minimax-portal": {
            models: [
              {
                id: "MiniMax-M2.7",
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "minimax",
      pluginName: "MiniMax Provider",
      source: "test",
      provider: {
        id: "minimax-portal",
        capabilities: ["image"],
        defaultModels: { image: "MiniMax-VL-01" },
        describeImage: async () => ({ text: "ok" }),
      },
    });
    setCompatibleActiveMediaUnderstandingRegistry(pluginRegistry, cfg);

    try {
      await expect(
        resolveAutoImageModel({
          cfg,
          activeModel: { provider: "minimax-portal", model: "MiniMax-M2.7" },
        }),
      ).resolves.toEqual({
        provider: "minimax-portal",
        model: "MiniMax-VL-01",
      });
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
    }
  });

  it("routes legacy MiniMax chat models through the VLM fallback even when cataloged with image input", async () => {
    catalog = [
      {
        id: "MiniMax-M2.7",
        name: "MiniMax M2.7",
        provider: "minimax-portal",
        input: ["text", "image"] as const,
      },
    ];
    const cfg = {
      models: {
        providers: {
          "minimax-portal": {
            models: [
              {
                id: "MiniMax-M2.7",
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "minimax",
      pluginName: "MiniMax Provider",
      source: "test",
      provider: {
        id: "minimax-portal",
        capabilities: ["image"],
        defaultModels: { image: "MiniMax-VL-01" },
        describeImage: async (req) => ({ text: "vlm ok", model: req.model }),
      },
    });
    setCompatibleActiveMediaUnderstandingRegistry(pluginRegistry, cfg);

    try {
      await withMediaFixture(
        {
          filePrefix: "openclaw-minimax-vlm-no-native-skip",
          extension: "png",
          mediaType: "image/png",
          fileContents: Buffer.from("image"),
        },
        async ({ ctx, media, cache }) => {
          const result = await runCapability({
            capability: "image",
            cfg,
            ctx,
            attachments: cache,
            media,
            agentDir: "/tmp",
            providerRegistry: buildProviderRegistry(undefined, cfg),
            activeModel: { provider: "minimax-portal", model: "MiniMax-M2.7" },
          });

          expect(result.decision.outcome).toBe("success");
          expect(result.outputs[0]).toEqual({
            kind: "image.description",
            attachmentIndex: 0,
            provider: "minimax-portal",
            model: "MiniMax-VL-01",
            text: "vlm ok",
          });
        },
      );
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
    }
  });

  it("uses active OpenRouter image models for auto image resolution", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    const cfg = {} as OpenClawConfig;
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "openrouter",
      pluginName: "OpenRouter Provider",
      source: "test",
      provider: {
        id: "openrouter",
        capabilities: ["image"],
        describeImage: async () => ({ text: "ok" }),
      },
    });
    setCompatibleActiveMediaUnderstandingRegistry(pluginRegistry, cfg);
    try {
      await expect(
        resolveAutoImageModel({
          cfg,
          activeModel: { provider: "openrouter", model: "google/gemini-2.5-flash" },
        }),
      ).resolves.toEqual({
        provider: "openrouter",
        model: "google/gemini-2.5-flash",
      });
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
      vi.unstubAllEnvs();
    }
  });

  it("auto-selects configured OpenRouter image providers with a resolved model", async () => {
    let seenModel: string | undefined;
    await withMediaFixture(
      {
        filePrefix: "openclaw-image-openrouter",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx, media, cache }) => {
        const cfg = {
          models: {
            providers: {
              openrouter: {
                apiKey: "test-openrouter-key", // pragma: allowlist secret
                models: [],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "image",
          cfg,
          ctx,
          attachments: cache,
          media,
          agentDir: "/tmp",
          providerRegistry: new Map([
            [
              "openrouter",
              {
                id: "openrouter",
                capabilities: ["image"],
                describeImage: async (req) => {
                  seenModel = req.model;
                  return { text: "openrouter ok", model: req.model };
                },
              },
            ],
          ]),
        });

        expect(result.decision.outcome).toBe("success");
        expect(result.outputs[0]?.provider).toBe("openrouter");
        expect(result.outputs[0]?.model).toBe("auto");
        expect(result.outputs[0]?.text).toBe("openrouter ok");
        expect(seenModel).toBe("auto");
      },
    );
  });

  it("skips configured image providers without an auto-resolvable model", async () => {
    await withMediaFixture(
      {
        filePrefix: "openclaw-image-custom-skip",
        extension: "png",
        mediaType: "image/png",
        fileContents: Buffer.from("image"),
      },
      async ({ ctx, media, cache }) => {
        const cfg = {
          models: {
            providers: {
              "custom-image": {
                apiKey: "test-custom-key", // pragma: allowlist secret
                models: [],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "image",
          cfg,
          ctx,
          attachments: cache,
          media,
          agentDir: "/tmp",
          providerRegistry: new Map([
            [
              "custom-image",
              {
                id: "custom-image",
                capabilities: ["image"],
                describeImage: async () => ({ text: "custom ok" }),
              },
            ],
          ]),
        });

        expect(result.outputs).toHaveLength(0);
        expect(result.decision.outcome).toBe("skipped");
        expect(result.decision.attachments).toEqual([{ attachmentIndex: 0, attempts: [] }]);
      },
    );
  });
});
