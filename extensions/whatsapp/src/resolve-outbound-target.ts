import { missingTargetError } from "openclaw/plugin-sdk/channel-feedback";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize-target.js";

export type WhatsAppOutboundTargetResolution =
  | { ok: true; to: string }
  | { ok: false; error: Error };

function whatsappAllowFromPolicyError(target: string): Error {
  return new Error(`Target "${target}" is not listed in the configured WhatsApp allowFrom policy.`);
}

function buildWhatsAppAllowFromPolicy(allowFrom: Array<string | number> | null | undefined): {
  hasWildcard: boolean;
  allowList: string[];
} {
  const allowListRaw = (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
  const hasWildcard = allowListRaw.includes("*");
  const allowList = allowListRaw
    .filter((entry) => entry !== "*")
    .map((entry) => normalizeWhatsAppTarget(entry))
    .filter((entry): entry is string => Boolean(entry));
  return { hasWildcard, allowList };
}

function allowFromPermitsNormalizedDm(params: {
  hasWildcard: boolean;
  allowList: string[];
  normalizedTo: string;
}): boolean {
  if (params.hasWildcard || params.allowList.length === 0) {
    return true;
  }
  return params.allowList.includes(params.normalizedTo);
}

/**
 * Last-line outbound recipient check for the WhatsApp web bridge (`send.ts`).
 * Enforces the same allowFrom / wildcard rules as {@link resolveWhatsAppOutboundTarget}
 * and returns the canonical target that must be passed to the active web listener.
 */
export function assertWhatsAppBridgeOutboundRecipientAllowed(params: {
  to: string;
  allowFrom: Array<string | number> | null | undefined;
}): string {
  const trimmed = params.to?.trim() ?? "";
  if (!trimmed) {
    throw missingTargetError("WhatsApp", "<E.164|group JID>");
  }
  const { hasWildcard, allowList } = buildWhatsAppAllowFromPolicy(params.allowFrom);
  const normalizedTo = normalizeWhatsAppTarget(trimmed);
  if (!normalizedTo) {
    throw missingTargetError("WhatsApp", "<E.164|group JID>");
  }
  if (isWhatsAppGroupJid(normalizedTo)) {
    return normalizedTo;
  }
  if (!allowFromPermitsNormalizedDm({ hasWildcard, allowList, normalizedTo })) {
    throw whatsappAllowFromPolicyError(normalizedTo);
  }
  return normalizedTo;
}

export function resolveWhatsAppOutboundTarget(params: {
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
  mode: string | null | undefined;
}): WhatsAppOutboundTargetResolution {
  const trimmed = params.to?.trim() ?? "";
  const { hasWildcard, allowList } = buildWhatsAppAllowFromPolicy(params.allowFrom);

  if (trimmed) {
    const normalizedTo = normalizeWhatsAppTarget(trimmed);
    if (!normalizedTo) {
      return {
        ok: false,
        error: missingTargetError("WhatsApp", "<E.164|group JID>"),
      };
    }
    if (isWhatsAppGroupJid(normalizedTo)) {
      return { ok: true, to: normalizedTo };
    }
    if (!allowFromPermitsNormalizedDm({ hasWildcard, allowList, normalizedTo })) {
      return {
        ok: false,
        error: whatsappAllowFromPolicyError(normalizedTo),
      };
    }
    return { ok: true, to: normalizedTo };
  }

  return {
    ok: false,
    error: missingTargetError("WhatsApp", "<E.164|group JID>"),
  };
}
