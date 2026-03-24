import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ImageEnrichmentProvider, ImageEnrichmentStoreMode } from "./imageEnrichment";
import { CloudImageProvider } from "./cloudImageProviders";
import { CorruptStateError } from "./stateErrors";
import { writeFileAtomically } from "./utils/atomicWrite";

export interface CliImageEnrichmentDefaults {
  mode: "off" | "local" | "cloud";
  provider: ImageEnrichmentProvider;
  cloudProvider: CloudImageProvider;
  cloudModel?: string;
  maxImagesPerRun: number;
  store: ImageEnrichmentStoreMode;
}

interface StoredCliImageEnrichmentConfig {
  version: 1;
  imageEnrichment: CliImageEnrichmentDefaults;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isImageEnrichmentMode(value: unknown): value is CliImageEnrichmentDefaults["mode"] {
  return value === "off" || value === "local" || value === "cloud";
}

function isImageEnrichmentProvider(value: unknown): value is ImageEnrichmentProvider {
  return value === "auto" || value === "apple-vision" || value === "tesseract";
}

function isCloudProvider(value: unknown): value is CloudImageProvider {
  return value === "openai" || value === "anthropic";
}

function isStoreMode(value: unknown): value is ImageEnrichmentStoreMode {
  return value === "alt-plus-comment" || value === "alt-only";
}

export const DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS: CliImageEnrichmentDefaults = {
  mode: "off",
  provider: "auto",
  cloudProvider: "openai",
  maxImagesPerRun: 25,
  store: "alt-plus-comment"
};

export function resolveDefaultCliConfigPath(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "GDriveSync", "cli-config.json");
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "GDriveSync", "cli-config.json");
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfigHome, "gdrivesync", "cli-config.json");
}

export function normalizeCliImageEnrichmentConfig(
  rawValue: unknown,
  stateLocation: string
): StoredCliImageEnrichmentConfig {
  if (!rawValue || typeof rawValue !== "object") {
    throw new CorruptStateError(
      "cli-config",
      stateLocation,
      `The saved GDriveSync CLI config at ${stateLocation} is malformed. Run gdrivesync doctor --repair or re-run gdrivesync configure image-enrichment.`
    );
  }

  const candidate = rawValue as Record<string, unknown>;
  if (candidate.version !== 1) {
    throw new CorruptStateError(
      "cli-config",
      stateLocation,
      `The saved GDriveSync CLI config at ${stateLocation} uses unsupported schema version ${String(candidate.version)}.`
    );
  }

  const rawImageEnrichment = candidate.imageEnrichment;
  if (!rawImageEnrichment || typeof rawImageEnrichment !== "object") {
    throw new CorruptStateError(
      "cli-config",
      stateLocation,
      `The saved GDriveSync CLI config at ${stateLocation} is missing image enrichment settings. Run gdrivesync doctor --repair or re-run gdrivesync configure image-enrichment.`
    );
  }

  const imageEnrichment = rawImageEnrichment as Record<string, unknown>;
  if (
    !isImageEnrichmentMode(imageEnrichment.mode) ||
    !isImageEnrichmentProvider(imageEnrichment.provider) ||
    !isCloudProvider(imageEnrichment.cloudProvider) ||
    !isStoreMode(imageEnrichment.store) ||
    typeof imageEnrichment.maxImagesPerRun !== "number" ||
    !Number.isFinite(imageEnrichment.maxImagesPerRun) ||
    imageEnrichment.maxImagesPerRun < 1
  ) {
    throw new CorruptStateError(
      "cli-config",
      stateLocation,
      `The saved GDriveSync CLI config at ${stateLocation} is missing required image enrichment fields. Run gdrivesync doctor --repair or re-run gdrivesync configure image-enrichment.`
    );
  }

  return {
    version: 1,
    imageEnrichment: {
      mode: imageEnrichment.mode,
      provider: imageEnrichment.provider,
      cloudProvider: imageEnrichment.cloudProvider,
      cloudModel: isNonEmptyString(imageEnrichment.cloudModel) ? imageEnrichment.cloudModel : undefined,
      maxImagesPerRun: Math.max(1, Math.floor(imageEnrichment.maxImagesPerRun)),
      store: imageEnrichment.store
    }
  };
}

export class CliImageEnrichmentConfigStore {
  constructor(private readonly filePath = resolveDefaultCliConfigPath()) {}

  getFilePath(): string {
    return this.filePath;
  }

  async read(): Promise<CliImageEnrichmentDefaults | undefined> {
    try {
      const rawValue = await readFile(this.filePath, "utf8");
      return normalizeCliImageEnrichmentConfig(JSON.parse(rawValue), this.filePath).imageEnrichment;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return undefined;
      }

      if (error instanceof SyntaxError) {
        throw new CorruptStateError("cli-config", this.filePath);
      }

      throw error;
    }
  }

  async write(defaults: CliImageEnrichmentDefaults): Promise<void> {
    const payload: StoredCliImageEnrichmentConfig = {
      version: 1,
      imageEnrichment: {
        mode: defaults.mode,
        provider: defaults.provider,
        cloudProvider: defaults.cloudProvider,
        cloudModel: defaults.cloudModel?.trim() || undefined,
        maxImagesPerRun: Math.max(1, Math.floor(defaults.maxImagesPerRun)),
        store: defaults.store
      }
    };
    await writeFileAtomically(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8"
    });
  }
}
