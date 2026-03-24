import { describe, expect, it, vi } from "vitest";

import { GoogleAuthManager } from "../../src/googleAuth";
import { ConnectedGoogleAccount, OAuthStateStore, StoredOAuthState } from "../../src/types";

function createAccount(accountId: string, refreshToken = `${accountId}-refresh`): ConnectedGoogleAccount {
  return {
    accountId,
    accountEmail: `${accountId}@example.com`,
    session: {
      accessToken: `${accountId}-access`,
      refreshToken,
      expiresAt: Date.now() + 60_000,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      tokenType: "Bearer"
    }
  };
}

function createStateStore(state: StoredOAuthState): OAuthStateStore & {
  save: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} {
  let currentState: StoredOAuthState | undefined = state;

  return {
    load: async () => currentState,
    save: vi.fn(async (nextState: StoredOAuthState) => {
      currentState = nextState;
    }),
    clear: vi.fn(async () => {
      currentState = undefined;
    })
  };
}

describe("GoogleAuthManager", () => {
  it("disconnects an account locally even when Google revocation fails", async () => {
    const stateStore = createStateStore({
      version: 1,
      defaultAccountId: "alpha",
      accounts: {
        alpha: createAccount("alpha")
      }
    });
    const manager = new GoogleAuthManager(
      stateStore,
      () => ({
        desktopClientId: "desktop-client-id",
        scope: "https://www.googleapis.com/auth/drive.readonly"
      }),
      async () => true,
      async () => new Response("revocation failed", { status: 500 })
    );

    const result = await manager.disconnectAccount("alpha");

    expect(result.account?.accountId).toBe("alpha");
    expect(result.revokeWarning).toContain("Google token revocation failed (500)");
    expect(stateStore.clear).toHaveBeenCalledOnce();
  });

  it("disconnects all accounts and reports only the failed revocations", async () => {
    const stateStore = createStateStore({
      version: 1,
      defaultAccountId: "alpha",
      accounts: {
        alpha: createAccount("alpha", "alpha-refresh"),
        beta: createAccount("beta", "beta-refresh")
      }
    });
    const manager = new GoogleAuthManager(
      stateStore,
      () => ({
        desktopClientId: "desktop-client-id",
        scope: "https://www.googleapis.com/auth/drive.readonly"
      }),
      async () => true,
      async (_url, init) => {
        const body = String(init?.body || "");
        if (body.includes("beta-refresh")) {
          throw new Error("network down");
        }

        return new Response("", { status: 200 });
      }
    );

    const result = await manager.disconnectAll();

    expect(result.disconnectedCount).toBe(2);
    expect(result.revokeWarnings).toEqual([
      expect.stringContaining("beta@example.com: Google token revocation request failed: network down")
    ]);
    expect(stateStore.clear).toHaveBeenCalledOnce();
  });
});
