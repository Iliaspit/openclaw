import { describe, expect, it } from "vitest";
import { mergeAuthProfileStores } from "./persisted.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

function oauthCredential(params: {
  access: string;
  expires: number;
  accountId?: string;
  provider?: string;
}): OAuthCredential {
  return {
    type: "oauth",
    provider: params.provider ?? "openai-codex",
    access: params.access,
    refresh: `${params.access}-refresh`,
    expires: params.expires,
    accountId: params.accountId,
  };
}

function storeWith(profileId: string, credential: OAuthCredential): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [profileId]: credential,
    },
  };
}

describe("mergeAuthProfileStores", () => {
  it("prefers a usable newer main OAuth credential over a stale child credential with the same profile id", () => {
    const profileId = "openai-codex:default";
    const merged = mergeAuthProfileStores(
      storeWith(
        profileId,
        oauthCredential({
          access: "main-fresh-access",
          expires: Date.now() + 60 * 60 * 1000,
          accountId: "acct-shared",
        }),
      ),
      storeWith(
        profileId,
        oauthCredential({
          access: "child-stale-access",
          expires: Date.now() - 60_000,
          accountId: "acct-shared",
        }),
      ),
    );

    expect(merged.profiles[profileId]).toMatchObject({
      access: "main-fresh-access",
      accountId: "acct-shared",
    });
  });

  it("keeps the child OAuth credential when the main credential belongs to a different account", () => {
    const profileId = "openai-codex:default";
    const merged = mergeAuthProfileStores(
      storeWith(
        profileId,
        oauthCredential({
          access: "main-foreign-access",
          expires: Date.now() + 60 * 60 * 1000,
          accountId: "acct-other",
        }),
      ),
      storeWith(
        profileId,
        oauthCredential({
          access: "child-own-access",
          expires: Date.now() - 60_000,
          accountId: "acct-child",
        }),
      ),
    );

    expect(merged.profiles[profileId]).toMatchObject({
      access: "child-own-access",
      accountId: "acct-child",
    });
  });

  it("keeps a newer usable child OAuth credential over an older main credential", () => {
    const profileId = "openai-codex:default";
    const merged = mergeAuthProfileStores(
      storeWith(
        profileId,
        oauthCredential({
          access: "main-older-access",
          expires: Date.now() + 30 * 60 * 1000,
          accountId: "acct-shared",
        }),
      ),
      storeWith(
        profileId,
        oauthCredential({
          access: "child-newer-access",
          expires: Date.now() + 60 * 60 * 1000,
          accountId: "acct-shared",
        }),
      ),
    );

    expect(merged.profiles[profileId]).toMatchObject({
      access: "child-newer-access",
      accountId: "acct-shared",
    });
  });
});
