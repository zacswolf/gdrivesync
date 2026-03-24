import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CliImageEnrichmentConfigStore,
  DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS,
  normalizeCliImageEnrichmentConfig
} from "../../src/cliImageEnrichmentConfig";
import { CorruptStateError } from "../../src/stateErrors";

describe("CliImageEnrichmentConfigStore", () => {
  let tempDirectory: string;
  let configPath: string;

  beforeEach(async () => {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gdrivesync-cli-config-"));
    configPath = path.join(tempDirectory, "cli-config.json");
  });

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });

  it("reads back saved defaults", async () => {
    const store = new CliImageEnrichmentConfigStore(configPath);
    await store.write({
      ...DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS,
      mode: "cloud",
      cloudProvider: "anthropic"
    });

    await expect(store.read()).resolves.toEqual({
      ...DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS,
      mode: "cloud",
      cloudProvider: "anthropic"
    });
  });

  it("throws a corruption error for malformed config JSON", async () => {
    await writeFile(configPath, "{not-json}\n", "utf8");
    const store = new CliImageEnrichmentConfigStore(configPath);

    await expect(store.read()).rejects.toBeInstanceOf(CorruptStateError);
  });

  it("normalizes a valid stored config payload", () => {
    expect(
      normalizeCliImageEnrichmentConfig(
        {
          version: 1,
          imageEnrichment: {
            mode: "local",
            provider: "apple-vision",
            cloudProvider: "openai",
            maxImagesPerRun: 40,
            store: "alt-only"
          }
        },
        configPath
      )
    ).toEqual({
      version: 1,
      imageEnrichment: {
        mode: "local",
        provider: "apple-vision",
        cloudProvider: "openai",
        cloudModel: undefined,
        maxImagesPerRun: 40,
        store: "alt-only"
      }
    });
  });

  it("writes a versioned config file", async () => {
    const store = new CliImageEnrichmentConfigStore(configPath);
    await store.write(DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS);

    const rawValue = await readFile(configPath, "utf8");
    expect(JSON.parse(rawValue)).toMatchObject({
      version: 1,
      imageEnrichment: {
        mode: "off",
        provider: "auto",
        cloudProvider: "openai",
        maxImagesPerRun: 25,
        store: "alt-plus-comment"
      }
    });
  });
});
