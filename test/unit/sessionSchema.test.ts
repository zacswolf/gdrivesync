import { describe, expect, it } from "vitest";

import { normalizeStoredOAuthSession } from "../../src/sessionSchema";
import { CorruptStateError } from "../../src/stateErrors";

describe("normalizeStoredOAuthSession", () => {
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
});
