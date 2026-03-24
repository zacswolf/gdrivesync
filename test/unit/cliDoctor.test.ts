import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCliDoctor } from "../../src/cliDoctor";
import { CliImageEnrichmentConfigStore, DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS } from "../../src/cliImageEnrichmentConfig";
import { CliManifestStore } from "../../src/cliManifestStore";
import { DriveClient } from "../../src/driveClient";
import { GoogleAuthManager } from "../../src/googleAuth";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "gdrivesync-cli-doctor-test-"));
}

describe("runCliDoctor", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(async (tempDir) => {
        await rm(tempDir, { recursive: true, force: true });
      })
    );
    tempDirs.length = 0;
  });

  it("reports a corrupt CLI image-enrichment config without repairing it", async () => {
    const rootPath = await makeTempDir();
    tempDirs.push(rootPath);
    const tokenPath = path.join(rootPath, "missing-session.json");
    const configPath = path.join(rootPath, "cli-config.json");
    await writeFile(configPath, "{not-json\n", "utf8");

    const report = await runCliDoctor(
      rootPath,
      tokenPath,
      new CliManifestStore(rootPath),
      {
        async getAccessToken() {
          throw new Error("should not be called");
        }
      } as unknown as GoogleAuthManager,
      {} as DriveClient,
      {},
      undefined,
      new CliImageEnrichmentConfigStore(configPath)
    );

    expect(report.imageEnrichment.config.exists).toBe(true);
    expect(report.imageEnrichment.config.valid).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "IMAGE_ENRICHMENT_CONFIG_CORRUPT",
          severity: "error",
          path: configPath
        })
      ])
    );
  });

  it("repairs a corrupt CLI image-enrichment config by backing it up and restoring defaults", async () => {
    const rootPath = await makeTempDir();
    tempDirs.push(rootPath);
    const tokenPath = path.join(rootPath, "missing-session.json");
    const configPath = path.join(rootPath, "cli-config.json");
    await writeFile(configPath, "{not-json\n", "utf8");

    const report = await runCliDoctor(
      rootPath,
      tokenPath,
      new CliManifestStore(rootPath),
      {
        async getAccessToken() {
          throw new Error("should not be called");
        }
      } as unknown as GoogleAuthManager,
      {} as DriveClient,
      { repair: true },
      undefined,
      new CliImageEnrichmentConfigStore(configPath)
    );

    expect(report.imageEnrichment.config.valid).toBe(true);
    expect(report.imageEnrichment.config.defaults).toEqual(DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS);
    expect(report.imageEnrichment.config.backupPath).toBeTruthy();
    expect(report.repair.performed).toBe(true);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "IMAGE_ENRICHMENT_CONFIG_CORRUPT",
          severity: "warning",
          path: configPath
        })
      ])
    );

    const repairedRaw = await readFile(configPath, "utf8");
    expect(JSON.parse(repairedRaw)).toEqual({
      version: 1,
      imageEnrichment: DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS
    });
  });
});
