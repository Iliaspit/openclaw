import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  loadConfig: () => ({
    channels: {
      whatsapp: {
        accounts: {
          work: {
            enabled: true,
            allowFrom: ["+1555"],
          },
        },
        defaultAccount: "work",
      },
    },
  }),
}));

type ActiveListenerModule = typeof import("./active-listener.js");

const activeListenerModuleUrl = new URL("./active-listener.ts", import.meta.url).href;

async function importActiveListenerModule(cacheBust: string): Promise<ActiveListenerModule> {
  return (await import(`${activeListenerModuleUrl}?t=${cacheBust}`)) as ActiveListenerModule;
}

function makeListener() {
  return {
    sendMessage: vi.fn(async () => ({ messageId: "msg-1" })),
    sendPoll: vi.fn(async () => ({ messageId: "poll-1" })),
    sendReaction: vi.fn(async () => {}),
    sendComposingTo: vi.fn(async () => {}),
  };
}

afterEach(() => {
  vi.doUnmock("./connection-controller-registry.js");
});

describe("active WhatsApp listener view", () => {
  it("reads controller-backed state across duplicate module instances", async () => {
    const listener = makeListener();
    vi.doMock("./connection-controller-registry.js", () => ({
      getRegisteredWhatsAppConnectionController: (accountId: string) =>
        accountId === "work"
          ? {
              getActiveListener: () => listener,
            }
          : null,
    }));

    const first = await importActiveListenerModule(`first-${Date.now()}`);
    const second = await importActiveListenerModule(`second-${Date.now()}`);

    await first.getActiveWebListener("work")?.sendMessage("+1555", "first");
    await second.getActiveWebListener("work")?.sendMessage("+1555", "second");

    expect(listener.sendMessage).toHaveBeenNthCalledWith(
      1,
      "+1555",
      "first",
      undefined,
      undefined,
      undefined,
    );
    expect(listener.sendMessage).toHaveBeenNthCalledWith(
      2,
      "+1555",
      "second",
      undefined,
      undefined,
      undefined,
    );
  });

  it("resolves the configured default account when accountId is omitted", async () => {
    const listener = makeListener();
    vi.doMock("./connection-controller-registry.js", () => ({
      getRegisteredWhatsAppConnectionController: (accountId: string) =>
        accountId === "work"
          ? {
              getActiveListener: () => listener,
            }
          : null,
    }));

    const mod = await importActiveListenerModule(`default-${Date.now()}`);

    expect(mod.resolveWebAccountId()).toBe("work");
    await mod.getActiveWebListener()?.sendPoll("+1555", {
      question: "Q?",
      options: ["A", "B"],
      maxSelections: 1,
    });
    expect(listener.sendPoll).toHaveBeenCalledWith("+1555", {
      question: "Q?",
      options: ["A", "B"],
      maxSelections: 1,
    });
  });

  it("returns null when the controller has no active listener for the account", async () => {
    vi.doMock("./connection-controller-registry.js", () => ({
      getRegisteredWhatsAppConnectionController: () => null,
    }));

    const mod = await importActiveListenerModule(`missing-${Date.now()}`);

    expect(mod.getActiveWebListener("work")).toBeNull();
  });

  it("blocks direct active listener sends outside allowFrom", async () => {
    const listener = makeListener();
    vi.doMock("./connection-controller-registry.js", () => ({
      getRegisteredWhatsAppConnectionController: (accountId: string) =>
        accountId === "work"
          ? {
              getActiveListener: () => listener,
            }
          : null,
    }));

    const mod = await importActiveListenerModule(`guard-${Date.now()}`);
    await expect(mod.getActiveWebListener("work")?.sendMessage("+1666", "blocked")).rejects.toThrow(
      /not listed in the configured WhatsApp allowFrom policy/,
    );

    expect(listener.sendMessage).not.toHaveBeenCalled();
  });
});
