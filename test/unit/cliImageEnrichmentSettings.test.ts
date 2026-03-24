import { describe, expect, it } from "vitest";

import { DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS } from "../../src/cliImageEnrichmentConfig";
import {
  hasCliImageEnrichmentFlagOverrides,
  resolveCliImageEnrichmentSettings,
  resolveCliImageEnrichmentSettingsFromDefaults
} from "../../src/cliImageEnrichmentSettings";
import { CorruptStateError } from "../../src/stateErrors";

describe("resolveCliImageEnrichmentSettingsFromDefaults", () => {
  it("uses saved defaults when no flags are provided", () => {
    expect(
      resolveCliImageEnrichmentSettingsFromDefaults(
        {},
        {
          ...DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS,
          mode: "cloud",
          cloudProvider: "anthropic"
        }
      )
    ).toEqual({
      mode: "cloud",
      provider: "auto",
      cloudProvider: "anthropic",
      cloudModel: undefined,
      maxImagesPerRun: 25,
      store: "alt-plus-comment",
      onlyWhenAltGeneric: true
    });
  });

  it("lets explicit flags override saved defaults", () => {
    expect(
      resolveCliImageEnrichmentSettingsFromDefaults(
        {
          imageEnrichmentMode: "local",
          imageEnrichmentProvider: "tesseract"
        },
        {
          ...DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS,
          mode: "cloud",
          cloudProvider: "openai"
        }
      )
    ).toEqual({
      mode: "local",
      provider: "tesseract",
      cloudProvider: "openai",
      cloudModel: undefined,
      maxImagesPerRun: 25,
      store: "alt-plus-comment",
      onlyWhenAltGeneric: true
    });
  });

  it("infers cloud mode from explicit cloud flags", () => {
    expect(
      resolveCliImageEnrichmentSettingsFromDefaults(
        {
          imageEnrichmentCloudProvider: "openai"
        },
        {
          ...DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS,
          mode: "local",
          provider: "apple-vision"
        }
      )
    ).toEqual({
      mode: "cloud",
      provider: "apple-vision",
      cloudProvider: "openai",
      cloudModel: undefined,
      maxImagesPerRun: 25,
      store: "alt-plus-comment",
      onlyWhenAltGeneric: true
    });
  });

  it("returns undefined when both flags and defaults resolve to off", () => {
    expect(resolveCliImageEnrichmentSettingsFromDefaults({}, DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS)).toBeUndefined();
  });

  it("detects when explicit image-enrichment flags are present", () => {
    expect(hasCliImageEnrichmentFlagOverrides({})).toBe(false);
    expect(hasCliImageEnrichmentFlagOverrides({ imageEnrichmentMode: "cloud" })).toBe(true);
    expect(hasCliImageEnrichmentFlagOverrides({ imageEnrichmentStore: "alt-only" })).toBe(true);
  });

  it("falls back to explicit flags when saved defaults are corrupt", async () => {
    await expect(
      resolveCliImageEnrichmentSettings(
        {
          imageEnrichmentMode: "local",
          imageEnrichmentProvider: "tesseract"
        },
        async () => {
          throw new CorruptStateError("cli-config", "/tmp/cli-config.json");
        }
      )
    ).resolves.toEqual({
      mode: "local",
      provider: "tesseract",
      cloudProvider: "openai",
      cloudModel: undefined,
      maxImagesPerRun: 25,
      store: "alt-plus-comment",
      onlyWhenAltGeneric: true
    });
  });

  it("still surfaces corrupt saved defaults when no explicit flags were provided", async () => {
    await expect(
      resolveCliImageEnrichmentSettings({}, async () => {
        throw new CorruptStateError("cli-config", "/tmp/cli-config.json");
      })
    ).rejects.toBeInstanceOf(CorruptStateError);
  });
});
