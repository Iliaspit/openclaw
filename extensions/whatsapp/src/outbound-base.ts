import {
  createAttachedChannelResultAdapter,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveOutboundSendDep, sanitizeForPlainText } from "openclaw/plugin-sdk/infra-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS } from "./outbound-send-deps.js";
import { assertWhatsAppBridgeOutboundRecipientAllowed } from "./resolve-outbound-target.js";

type WhatsAppChunker = NonNullable<ChannelOutboundAdapter["chunker"]>;
type WhatsAppSendTextOptions = {
  verbose: boolean;
  cfg?: OpenClawConfig;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  gifPlayback?: boolean;
  accountId?: string;
};
type WhatsAppSendMessage = (
  to: string,
  body: string,
  options: WhatsAppSendTextOptions,
) => Promise<{ messageId: string; toJid: string }>;
type WhatsAppSendPoll = (
  to: string,
  poll: Parameters<NonNullable<ChannelOutboundAdapter["sendPoll"]>>[0]["poll"],
  options: { verbose: boolean; accountId?: string; cfg?: OpenClawConfig },
) => Promise<{ messageId: string; toJid: string }>;

type CreateWhatsAppOutboundBaseParams = {
  chunker: WhatsAppChunker;
  sendMessageWhatsApp: WhatsAppSendMessage;
  sendPollWhatsApp: WhatsAppSendPoll;
  shouldLogVerbose: () => boolean;
  resolveTarget: ChannelOutboundAdapter["resolveTarget"];
  normalizeText?: (text: string | undefined) => string;
  skipEmptyText?: boolean;
};

function resolveGuardedOutboundTarget(params: {
  cfg: OpenClawConfig;
  to: string;
  accountId?: string;
}): string {
  const account = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return assertWhatsAppBridgeOutboundRecipientAllowed({
    to: params.to,
    allowFrom: account.allowFrom ?? [],
  });
}

export function createWhatsAppOutboundBase({
  chunker,
  sendMessageWhatsApp,
  sendPollWhatsApp,
  shouldLogVerbose,
  resolveTarget,
  normalizeText = (text) => text ?? "",
  skipEmptyText = false,
}: CreateWhatsAppOutboundBaseParams): Pick<
  ChannelOutboundAdapter,
  | "deliveryMode"
  | "chunker"
  | "chunkerMode"
  | "textChunkLimit"
  | "sanitizeText"
  | "pollMaxOptions"
  | "resolveTarget"
  | "sendText"
  | "sendMedia"
  | "sendPoll"
> {
  return {
    deliveryMode: "gateway",
    chunker,
    chunkerMode: "text",
    textChunkLimit: 4000,
    sanitizeText: ({ text }) => sanitizeForPlainText(text),
    pollMaxOptions: 12,
    resolveTarget,
    ...createAttachedChannelResultAdapter({
      channel: "whatsapp",
      sendText: async ({ cfg, to, text, accountId, deps, gifPlayback }) => {
        const normalizedText = normalizeText(text);
        if (skipEmptyText && !normalizedText) {
          return { messageId: "" };
        }
        const sendTarget = resolveGuardedOutboundTarget({
          cfg,
          to,
          accountId: accountId ?? undefined,
        });
        const send =
          resolveOutboundSendDep<WhatsAppSendMessage>(deps, "whatsapp", {
            legacyKeys: WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS,
          }) ?? sendMessageWhatsApp;
        return await send(sendTarget, normalizedText, {
          verbose: false,
          cfg,
          accountId: accountId ?? undefined,
          gifPlayback,
        });
      },
      sendMedia: async ({
        cfg,
        to,
        text,
        mediaUrl,
        mediaAccess,
        mediaLocalRoots,
        mediaReadFile,
        accountId,
        deps,
        gifPlayback,
      }) => {
        const sendTarget = resolveGuardedOutboundTarget({
          cfg,
          to,
          accountId: accountId ?? undefined,
        });
        const send =
          resolveOutboundSendDep<WhatsAppSendMessage>(deps, "whatsapp", {
            legacyKeys: WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS,
          }) ?? sendMessageWhatsApp;
        return await send(sendTarget, normalizeText(text), {
          verbose: false,
          cfg,
          mediaUrl,
          mediaAccess,
          mediaLocalRoots,
          mediaReadFile,
          accountId: accountId ?? undefined,
          gifPlayback,
        });
      },
      sendPoll: async ({ cfg, to, poll, accountId }) => {
        const sendTarget = resolveGuardedOutboundTarget({
          cfg,
          to,
          accountId: accountId ?? undefined,
        });
        return await sendPollWhatsApp(sendTarget, poll, {
          verbose: shouldLogVerbose(),
          accountId: accountId ?? undefined,
          cfg,
        });
      },
    }),
  };
}
