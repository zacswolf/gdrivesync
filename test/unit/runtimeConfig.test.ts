import { describe, expect, it } from "vitest";

import { shouldLoadCliDevelopmentEnv } from "../../src/runtimeConfig";

describe("runtimeConfig", () => {
  it("only enables CLI .env loading when explicitly requested", () => {
    expect(shouldLoadCliDevelopmentEnv({})).toBe(false);
    expect(shouldLoadCliDevelopmentEnv({ GDRIVESYNC_LOAD_DEV_ENV: "0" })).toBe(false);
    expect(shouldLoadCliDevelopmentEnv({ GDRIVESYNC_LOAD_DEV_ENV: "1" })).toBe(true);
  });
});
