import { describe, expect, it } from "vitest";

import { hasRequiredScopes } from "../../src/utils/oauthScopes";

describe("hasRequiredScopes", () => {
  it("accepts an exact scope match", () => {
    expect(hasRequiredScopes("https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.readonly")).toBe(true);
  });

  it("accepts a granted scope set that contains the required scope", () => {
    expect(
      hasRequiredScopes(
        "openid email https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/drive.readonly"
      )
    ).toBe(true);
  });

  it("rejects a granted scope set that is missing the required scope", () => {
    expect(hasRequiredScopes("https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/drive.readonly")).toBe(
      false
    );
  });

  it("requires every scope in a multi-scope requirement", () => {
    expect(
      hasRequiredScopes(
        "openid email https://www.googleapis.com/auth/drive.readonly",
        "openid https://www.googleapis.com/auth/drive.readonly"
      )
    ).toBe(true);
    expect(hasRequiredScopes("openid", "openid https://www.googleapis.com/auth/drive.readonly")).toBe(false);
  });
});
