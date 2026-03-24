import { describe, expect, it } from "vitest";

import { EnvironmentOrStoredCloudKeyResolver, getProviderEnvVar } from "../../src/providerKeyStores";

describe("EnvironmentOrStoredCloudKeyResolver", () => {
  it("prefers environment variables over stored keychain values", async () => {
    const resolver = new EnvironmentOrStoredCloudKeyResolver(
      {
        async get() {
          return "stored-openai-key";
        },
        async set() {
          throw new Error("not needed");
        },
        async delete() {
          throw new Error("not needed");
        }
      },
      {
        [getProviderEnvVar("openai")]: "env-openai-key"
      }
    );

    await expect(resolver.resolve("openai")).resolves.toEqual({
      provider: "openai",
      apiKey: "env-openai-key",
      source: "environment"
    });
  });

  it("falls back to stored values when environment variables are missing", async () => {
    const resolver = new EnvironmentOrStoredCloudKeyResolver(
      {
        async get(provider) {
          return provider === "anthropic" ? "stored-anthropic-key" : undefined;
        },
        async set() {
          throw new Error("not needed");
        },
        async delete() {
          throw new Error("not needed");
        }
      },
      {}
    );

    await expect(resolver.resolve("anthropic")).resolves.toEqual({
      provider: "anthropic",
      apiKey: "stored-anthropic-key",
      source: "keychain"
    });
  });
});
