import { CliImageEnrichmentDefaults } from "./cliImageEnrichmentConfig";
import { ImageEnrichmentSettings } from "./imageEnrichment";
import { CorruptStateError } from "./stateErrors";

export interface CliImageEnrichmentFlagOverrides {
  imageEnrichmentMode?: ImageEnrichmentSettings["mode"];
  imageEnrichmentProvider?: ImageEnrichmentSettings["provider"];
  imageEnrichmentCloudProvider?: ImageEnrichmentSettings["cloudProvider"];
  imageEnrichmentCloudModel?: string;
  imageEnrichmentMaxImages?: number;
  imageEnrichmentStore?: ImageEnrichmentSettings["store"];
}

export function hasCliImageEnrichmentFlagOverrides(flags: CliImageEnrichmentFlagOverrides): boolean {
  return Boolean(
    flags.imageEnrichmentMode ||
      flags.imageEnrichmentProvider ||
      flags.imageEnrichmentCloudProvider ||
      flags.imageEnrichmentCloudModel ||
      flags.imageEnrichmentMaxImages ||
      flags.imageEnrichmentStore
  );
}

export function resolveCliImageEnrichmentSettingsFromDefaults(
  flags: CliImageEnrichmentFlagOverrides,
  defaults?: CliImageEnrichmentDefaults
): ImageEnrichmentSettings | undefined {
  const inferredMode =
    flags.imageEnrichmentMode ||
    (
      flags.imageEnrichmentCloudProvider ||
      flags.imageEnrichmentCloudModel ||
      flags.imageEnrichmentMaxImages
        ? "cloud"
        : flags.imageEnrichmentProvider
          ? "local"
          : flags.imageEnrichmentStore
            ? defaults?.mode && defaults.mode !== "off"
              ? defaults.mode
              : "local"
            : defaults?.mode || "off"
    );
  if (inferredMode === "off" || inferredMode === "prompt") {
    return undefined;
  }

  return {
    mode: inferredMode,
    provider: flags.imageEnrichmentProvider || defaults?.provider || "auto",
    cloudProvider: flags.imageEnrichmentCloudProvider || defaults?.cloudProvider || "openai",
    cloudModel: flags.imageEnrichmentCloudModel || defaults?.cloudModel,
    maxImagesPerRun: flags.imageEnrichmentMaxImages || defaults?.maxImagesPerRun || 25,
    store: flags.imageEnrichmentStore || defaults?.store || "alt-plus-comment",
    onlyWhenAltGeneric: true
  };
}

export async function resolveCliImageEnrichmentSettings(
  flags: CliImageEnrichmentFlagOverrides,
  loadDefaults: () => Promise<CliImageEnrichmentDefaults | undefined>
): Promise<ImageEnrichmentSettings | undefined> {
  try {
    const defaults = await loadDefaults();
    return resolveCliImageEnrichmentSettingsFromDefaults(flags, defaults);
  } catch (error) {
    if (error instanceof CorruptStateError && error.kind === "cli-config" && hasCliImageEnrichmentFlagOverrides(flags)) {
      return resolveCliImageEnrichmentSettingsFromDefaults(flags, undefined);
    }

    throw error;
  }
}
