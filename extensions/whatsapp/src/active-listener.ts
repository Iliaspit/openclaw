import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveDefaultWhatsAppAccountId, resolveWhatsAppAccount } from "./accounts.js";
import { getRegisteredWhatsAppConnectionController } from "./connection-controller-registry.js";
import type { ActiveWebListener, ActiveWebSendOptions } from "./inbound/types.js";
import { assertWhatsAppBridgeOutboundRecipientAllowed } from "./resolve-outbound-target.js";

export type { ActiveWebListener, ActiveWebSendOptions } from "./inbound/types.js";

export function resolveWebAccountId(accountId?: string | null): string {
  return (accountId ?? "").trim() || resolveDefaultWhatsAppAccountId(loadConfig());
}

function resolveGuardedTarget(accountId: string, to: string): string {
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId });
  return assertWhatsAppBridgeOutboundRecipientAllowed({
    to,
    allowFrom: account.allowFrom ?? [],
  });
}

function createGuardedActiveWebListener(
  accountId: string,
  listener: ActiveWebListener,
): ActiveWebListener {
  return {
    ...listener,
    sendMessage: async (to, text, mediaBuffer, mediaType, options) =>
      await listener.sendMessage(
        resolveGuardedTarget(accountId, to),
        text,
        mediaBuffer,
        mediaType,
        options,
      ),
    sendPoll: async (to, poll) =>
      await listener.sendPoll(resolveGuardedTarget(accountId, to), poll),
    sendReaction: async (chatJid, messageId, emoji, fromMe, participant) =>
      await listener.sendReaction(
        resolveGuardedTarget(accountId, chatJid),
        messageId,
        emoji,
        fromMe,
        participant,
      ),
    sendComposingTo: async (to) =>
      await listener.sendComposingTo(resolveGuardedTarget(accountId, to)),
  };
}

export function getActiveWebListener(accountId?: string | null): ActiveWebListener | null {
  const id = resolveWebAccountId(accountId);
  const listener = getRegisteredWhatsAppConnectionController(id)?.getActiveListener() ?? null;
  return listener ? createGuardedActiveWebListener(id, listener) : null;
}
