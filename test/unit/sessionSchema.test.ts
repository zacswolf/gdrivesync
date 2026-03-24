import { describe, expect, it } from "vitest";

import { normalizeStoredOAuthSession, normalizeStoredOAuthState } from "../../src/sessionSchema";
import { CorruptStateError } from "../../src/stateErrors";

describe("sessionSchema", () => {
  it("accepts a valid saved OAuth session", () => {
    const session = normalizeStoredOAuthSession(
      {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 60_000,
        scope: "https://www.googleapis.com/auth/drive.readonly",
        tokenType: "Bearer"
      },
      "/tmp/.gdrivesync-dev-session.json"
    );

    expect(session.accessToken).toBe("access-token");
    expect(session.refreshToken).toBe("refresh-token");
    expect(session.tokenType).toBe("Bearer");
  });

  it("accepts a valid multi-account OAuth state", () => {
    const state = normalizeStoredOAuthState(
      {
        version: 1,
        defaultAccountId: "perm-1",
        accounts: {
          "perm-1": {
            accountId: "perm-1",
            accountEmail: "me@example.com",
            session: {
              accessToken: "access-token",
              refreshToken: "refresh-token",
              expiresAt: Date.now() + 60_000,
              scope: "https://www.googleapis.com/auth/drive.readonly",
              tokenType: "Bearer"
            }
          }
        }
      },
      "/tmp/.gdrivesync-dev-session.json"
    );

    expect(state.defaultAccountId).toBe("perm-1");
    expect(Object.keys(state.accounts)).toEqual(["perm-1"]);
  });

  it("throws a corruption error for malformed saved OAuth sessions", () => {
    expect(() =>
      normalizeStoredOAuthSession(
        {
          accessToken: "access-token",
          scope: "https://www.googleapis.com/auth/drive.readonly"
        },
        "/tmp/.gdrivesync-dev-session.json"
      )
    ).toThrowError(CorruptStateError);
  });

  it("rejects OAuth state that points at a missing default account", () => {
    expect(() =>
      normalizeStoredOAuthState(
        {
          version: 1,
          defaultAccountId: "perm-2",
          accounts: {
            "perm-1": {
              accountId: "perm-1",
              accountEmail: "me@example.com",
              session: {
                accessToken: "access-token",
                refreshToken: "refresh-token",
                expiresAt: Date.now() + 60_000,
                scope: "https://www.googleapis.com/auth/drive.readonly",
                tokenType: "Bearer"
              }
            }
          }
        },
        "/tmp/.gdrivesync-dev-session.json"
      )
    ).toThrowError(CorruptStateError);
  });
});
