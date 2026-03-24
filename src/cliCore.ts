import path from "node:path";
import { stat } from "node:fs/promises";

import { inspectCliAuthState, formatDoctorReport, runCliDoctor } from "./cliDoctor";
import {
  CliImageEnrichmentConfigStore,
  CliImageEnrichmentDefaults,
  DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS
} from "./cliImageEnrichmentConfig";
import { resolveCliImageEnrichmentSettings } from "./cliImageEnrichmentSettings";
import { CliManifestStore } from "./cliManifestStore";
import { CliSyncManager } from "./cliSync";
import { CloudCredentialSource, CloudImageProvider, formatCloudProviderLabel, resolveCloudModel } from "./cloudImageProviders";
import { DriveClient, GoogleApiError, PickerGrantRequiredError } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { ImageEnrichmentService, ImageEnrichmentSettings } from "./imageEnrichment";
import {
  EnvironmentOrStoredCloudKeyResolver,
  KeychainCloudProviderKeyStore,
  formatCloudCredentialSource,
  getProviderEnvVar
} from "./providerKeyStores";
import { SlidesClient } from "./slidesClient";
import { CorruptStateError } from "./stateErrors";
import { resolveSyncProfileForMimeType } from "./syncProfiles";
import { buildCliSyncAllSummary } from "./utils/cliSyncSummary";
import { parseGoogleDocInput } from "./utils/docUrl";
import { fromManifestKey } from "./utils/paths";
import { ConnectedGoogleAccount } from "./types";

export const CLI_JSON_CONTRACT_VERSION = 1;

export interface CliFlags {
  json: boolean;
  all: boolean;
  account?: string;
  force: boolean;
  removeGenerated: boolean;
  includeBackgrounds: boolean;
  repair: boolean;
  cwd?: string;
  imageEnrichmentMode?: ImageEnrichmentSettings["mode"];
  imageEnrichmentProvider?: ImageEnrichmentSettings["provider"];
  imageEnrichmentCloudProvider?: ImageEnrichmentSettings["cloudProvider"];
  imageEnrichmentCloudModel?: string;
  imageEnrichmentMaxImages?: number;
  imageEnrichmentStore?: ImageEnrichmentSettings["store"];
}

export interface ParsedCliInput {
  command: string;
  subcommand?: string;
  nestedSubcommand?: string;
  args: string[];
  flags: CliFlags;
}

export interface CliIo {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
  promptSecret(prompt: string): Promise<string>;
  promptChoice<T>(prompt: string, options: Array<{ label: string; value: T; detail?: string }>): Promise<T | undefined>;
}

export interface CliServices {
  tokenPath: string;
  authManager: GoogleAuthManager;
  driveClient: DriveClient;
  slidesClient: SlidesClient;
  cloudKeyStore: KeychainCloudProviderKeyStore;
  cloudKeyResolver: EnvironmentOrStoredCloudKeyResolver;
  cliImageEnrichmentConfigStore: CliImageEnrichmentConfigStore;
  imageEnrichmentService: ImageEnrichmentService;
  manifestStore: CliManifestStore;
  syncManager: CliSyncManager;
}

export interface CliRuntime {
  cwd: string;
  loadDevelopmentEnv(cwd: string): Promise<void>;
  resolveWorkspaceRoot(cwdFlag?: string): string;
  createServices(workspaceRoot: string): CliServices;
}

let currentIo: CliIo | undefined;
let currentRuntime: CliRuntime | undefined;
let currentExitCode = 0;

function requireIo(): CliIo {
  if (!currentIo) {
    throw new Error("CLI IO has not been initialized.");
  }
  return currentIo;
}

function requireRuntime(): CliRuntime {
  if (!currentRuntime) {
    throw new Error("CLI runtime has not been initialized.");
  }
  return currentRuntime;
}

function printUsage(): void {
  requireIo().writeStdout(`Usage:
  gdrivesync auth login
  gdrivesync auth logout --account <account>
  gdrivesync auth logout --all
  gdrivesync auth list [--json]
  gdrivesync auth use <account> [--json]
  gdrivesync auth status [--json]
  gdrivesync ai auth login openai
  gdrivesync ai auth login anthropic
  gdrivesync ai auth logout openai
  gdrivesync ai auth logout anthropic
  gdrivesync ai auth status [--json]
  gdrivesync ai auth test openai|anthropic [--json]
  gdrivesync configure image-enrichment [--json]
  gdrivesync doctor [--cwd path] [--json] [--repair]
  gdrivesync inspect <google-file-url-or-id> [--json]
  gdrivesync metadata <google-file-url-or-id> [--json]
  gdrivesync export <google-file-url-or-id> [output-path] [--json] [--include-backgrounds] [--image-enrichment off|local|cloud|hybrid] [--image-enrichment-provider auto|apple-vision|tesseract] [--image-enrichment-cloud-provider openai|anthropic] [--image-enrichment-cloud-model <model>] [--image-enrichment-max-images <n>] [--image-enrichment-store alt-plus-comment|alt-only]
  gdrivesync link <google-file-url-or-id> <local-path> [--cwd path] [--json] [--force] [--image-enrichment off|local|cloud|hybrid] [--image-enrichment-provider auto|apple-vision|tesseract] [--image-enrichment-cloud-provider openai|anthropic] [--image-enrichment-cloud-model <model>] [--image-enrichment-max-images <n>] [--image-enrichment-store alt-plus-comment|alt-only]
  gdrivesync status <local-path> [--cwd path] [--json]
  gdrivesync status --all [--cwd path] [--json]
  gdrivesync sync <local-path> [--cwd path] [--json] [--force] [--image-enrichment off|local|cloud|hybrid] [--image-enrichment-provider auto|apple-vision|tesseract] [--image-enrichment-cloud-provider openai|anthropic] [--image-enrichment-cloud-model <model>] [--image-enrichment-max-images <n>] [--image-enrichment-store alt-plus-comment|alt-only]
  gdrivesync sync --all [--cwd path] [--json] [--force] [--image-enrichment off|local|cloud|hybrid] [--image-enrichment-provider auto|apple-vision|tesseract] [--image-enrichment-cloud-provider openai|anthropic] [--image-enrichment-cloud-model <model>] [--image-enrichment-max-images <n>] [--image-enrichment-store alt-plus-comment|alt-only]
  gdrivesync unlink <local-path> [--cwd path] [--json] [--remove-generated]

Flags:
  --json              Emit machine-readable JSON
  --cwd <path>        Workspace root to use for manifest operations
  --all               Target every linked file in the manifest
  --account <value>   Google account email or account ID to target
  --force             Overwrite local changes during sync
  --remove-generated   Remove tracked generated files when unlinking
  --include-backgrounds  For oversized Google Slides decks that fall back to the Slides API, include slide background images
  --image-enrichment   Control image enrichment for Markdown/Marp outputs (off, local, cloud, or hybrid)
  --image-enrichment-provider  Choose the local OCR provider (auto, apple-vision, or tesseract)
  --image-enrichment-cloud-provider  Choose the cloud AI provider (openai or anthropic)
  --image-enrichment-cloud-model  Override the cloud model name
  --image-enrichment-max-images  Cap cloud or hybrid enrichment to N images per file (default 25)
  --image-enrichment-store  Store OCR as rewritten alt text only or alt text plus HTML comments
  --repair            Let doctor back up corrupt local state and restore a working baseline
`);
}

export function parseCliInput(rawArgs: string[]): ParsedCliInput {
  const flags: CliFlags = {
    json: false,
    all: false,
    force: false,
    removeGenerated: false,
    includeBackgrounds: false,
    repair: false
  };
  const positionals: string[] = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--all") {
      flags.all = true;
      continue;
    }
    if (arg === "--account") {
      const value = rawArgs[index + 1];
      if (!value) {
        throw new Error("--account requires an email or account ID.");
      }
      flags.account = value;
      index += 1;
      continue;
    }
    if (arg === "--force" || arg === "--yes") {
      flags.force = true;
      continue;
    }
    if (arg === "--remove-generated") {
      flags.removeGenerated = true;
      continue;
    }
    if (arg === "--include-backgrounds") {
      flags.includeBackgrounds = true;
      continue;
    }
    if (arg === "--repair") {
      flags.repair = true;
      continue;
    }
    if (arg === "--image-enrichment") {
      const value = rawArgs[index + 1];
      if (value !== "off" && value !== "local" && value !== "cloud" && value !== "hybrid") {
        throw new Error("--image-enrichment requires off, local, cloud, or hybrid.");
      }
      flags.imageEnrichmentMode = value;
      index += 1;
      continue;
    }
    if (arg === "--image-enrichment-provider") {
      const value = rawArgs[index + 1];
      if (value !== "auto" && value !== "apple-vision" && value !== "tesseract") {
        throw new Error("--image-enrichment-provider requires auto, apple-vision, or tesseract.");
      }
      flags.imageEnrichmentProvider = value;
      index += 1;
      continue;
    }
    if (arg === "--image-enrichment-cloud-provider") {
      const value = rawArgs[index + 1];
      if (value !== "openai" && value !== "anthropic") {
        throw new Error("--image-enrichment-cloud-provider requires openai or anthropic.");
      }
      flags.imageEnrichmentCloudProvider = value;
      index += 1;
      continue;
    }
    if (arg === "--image-enrichment-cloud-model") {
      const value = rawArgs[index + 1];
      if (!value) {
        throw new Error("--image-enrichment-cloud-model requires a model name.");
      }
      flags.imageEnrichmentCloudModel = value;
      index += 1;
      continue;
    }
    if (arg === "--image-enrichment-max-images") {
      const value = Number(rawArgs[index + 1]);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--image-enrichment-max-images requires a positive integer.");
      }
      flags.imageEnrichmentMaxImages = Math.floor(value);
      index += 1;
      continue;
    }
    if (arg === "--image-enrichment-store") {
      const value = rawArgs[index + 1];
      if (value !== "alt-plus-comment" && value !== "alt-only") {
        throw new Error("--image-enrichment-store requires alt-plus-comment or alt-only.");
      }
      flags.imageEnrichmentStore = value;
      index += 1;
      continue;
    }
    if (arg === "--cwd") {
      const value = rawArgs[index + 1];
      if (!value) {
        throw new Error("--cwd requires a path.");
      }
      flags.cwd = value;
      index += 1;
      continue;
    }

    positionals.push(arg);
  }

  const [command, maybeSubcommand, ...rest] = positionals;
  if (!command) {
    return {
      command: "",
      args: [],
      flags
    };
  }

  if (command === "auth") {
    return {
      command,
      subcommand: maybeSubcommand,
      args: rest,
      flags
    };
  }

  if (command === "ai") {
    return {
      command,
      subcommand: maybeSubcommand,
      nestedSubcommand: rest[0],
      args: rest.slice(1),
      flags
    };
  }

  if (command === "configure") {
    return {
      command,
      subcommand: maybeSubcommand,
      args: rest,
      flags
    };
  }

  return {
    command,
    args: [maybeSubcommand, ...rest].filter((value): value is string => Boolean(value)),
    flags
  };
}

function printJson(value: unknown): void {
  requireIo().writeStdout(`${JSON.stringify(value, null, 2)}\n`);
}

export function getCommandLabel(parsed: ParsedCliInput): string {
  if (parsed.command === "auth") {
    return `auth.${parsed.subcommand || "unknown"}`;
  }
  if (parsed.command === "ai") {
    return `ai.${parsed.subcommand || "unknown"}.${parsed.nestedSubcommand || "unknown"}`;
  }
  if (parsed.command === "configure") {
    return `configure.${parsed.subcommand || "unknown"}`;
  }

  return parsed.command || "unknown";
}

function printJsonSuccess(parsed: ParsedCliInput, data: unknown): void {
  printJson({
    ok: true,
    contractVersion: CLI_JSON_CONTRACT_VERSION,
    command: getCommandLabel(parsed),
    data
  });
}

export function buildCliErrorPayload(error: unknown): {
  code: string;
  message: string;
  recoverable: boolean;
  advice?: string;
  path?: string;
} {
  if (error instanceof CorruptStateError) {
    return {
      code:
        error.kind === "manifest"
          ? "MANIFEST_CORRUPT"
          : error.kind === "cli-config"
            ? "CLI_CONFIG_CORRUPT"
            : "AUTH_SESSION_CORRUPT",
      message: error.message,
      recoverable: true,
      advice: "Run gdrivesync doctor --repair to back up the corrupt state and restore a working baseline.",
      path: error.stateLocation
    };
  }

  if (error instanceof PickerGrantRequiredError) {
    return {
      code: "GOOGLE_ACCESS_DENIED",
      message: error.message,
      recoverable: true,
      advice: "Verify the connected Google account can read the file, or retry with a shared-link URL that includes its resource key."
    };
  }

  if (error instanceof GoogleApiError && error.reason === "exportSizeLimitExceeded") {
    return {
      code: "GOOGLE_EXPORT_TOO_LARGE",
      message: error.message,
      recoverable: true,
      advice: "Retry with a lighter export mode, or let GDriveSync fall back to a format-specific API path when available."
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("You need to sign in to Google") || message.includes("connect a Google account before syncing")) {
    return {
      code: "AUTH_REQUIRED",
      message,
      recoverable: true,
      advice: "Run gdrivesync auth login."
    };
  }
  if (
    message.includes("requires") ||
    message.includes("must target") ||
    message.includes("Pass a ") ||
    message.startsWith("Use one of:")
  ) {
    return {
      code: "INVALID_ARGUMENT",
      message,
      recoverable: true,
      advice: "Check the command usage and required path or URL arguments."
    };
  }
  if (message.includes("not linked to a Google source")) {
    return {
      code: "NOT_LINKED",
      message,
      recoverable: true,
      advice: "Link the local file first with gdrivesync link."
    };
  }
  if (message.includes("Local changes detected")) {
    return {
      code: "LOCAL_CHANGES_BLOCK_SYNC",
      message,
      recoverable: true,
      advice: "Re-run the sync with --force if you intend to overwrite the local file."
    };
  }
  if (message.includes("Google desktop OAuth is not configured")) {
    return {
      code: "CONFIGURATION_ERROR",
      message,
      recoverable: true,
      advice: "Set the local Google OAuth configuration before using the CLI."
    };
  }
  if (message.includes("API key") && message.includes("not configured")) {
    return {
      code: "AI_AUTH_REQUIRED",
      message,
      recoverable: true,
      advice: "Run gdrivesync ai auth login <provider> or set OPENAI_API_KEY / ANTHROPIC_API_KEY."
    };
  }
  if (message.includes("OS keychain is unavailable")) {
    return {
      code: "AI_KEYCHAIN_UNAVAILABLE",
      message,
      recoverable: true,
      advice: "Use OPENAI_API_KEY or ANTHROPIC_API_KEY for automation if keychain storage is unavailable."
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    message,
    recoverable: false
  };
}

function printText(value: string): void {
  requireIo().writeStdout(`${value}\n`);
}

function markFailure(): void {
  currentExitCode = 1;
}

function resolveWorkspaceRoot(cwdFlag: string | undefined): string {
  return requireRuntime().resolveWorkspaceRoot(cwdFlag);
}

function resolveLocalPath(rootPath: string, filePath: string): string {
  return path.resolve(rootPath, filePath);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function describeLinkedFile(manifestStore: CliManifestStore, filePath: string): Promise<Record<string, unknown>> {
  const linkedFile = await manifestStore.getLinkedFile(filePath);
  if (!linkedFile) {
    return {
      linked: false,
      targetPath: path.resolve(filePath)
    };
  }

  const primaryPath = fromManifestKey(linkedFile.folderPath, linkedFile.key);
  const generatedFiles = linkedFile.entry.generatedFiles || [];

  return {
    linked: true,
    targetPath: path.resolve(filePath),
    primaryPath,
    matchedOutputKind: linkedFile.matchedOutputKind,
    manifestPath: linkedFile.manifestPath,
    manifestKey: linkedFile.key,
    fileExists: await pathExists(filePath),
    entry: {
      profileId: linkedFile.entry.profileId,
      title: linkedFile.entry.title,
      sourceUrl: linkedFile.entry.sourceUrl,
      sourceMimeType: linkedFile.entry.sourceMimeType,
      localFormat: linkedFile.entry.localFormat,
      outputKind: linkedFile.entry.outputKind,
      accountId: linkedFile.entry.accountId,
      accountEmail: linkedFile.entry.accountEmail,
      syncOnOpen: linkedFile.entry.syncOnOpen,
      lastSyncedAt: linkedFile.entry.lastSyncedAt,
      lastDriveVersion: linkedFile.entry.lastDriveVersion,
      generatedFileCount: generatedFiles.length
    }
  };
}

function serializeAccount(account: ConnectedGoogleAccount, defaultAccountId?: string) {
  return {
    accountId: account.accountId,
    accountEmail: account.accountEmail,
    accountDisplayName: account.accountDisplayName,
    isDefault: defaultAccountId === account.accountId
  };
}

function isCloudProvider(value: string | undefined): value is CloudImageProvider {
  return value === "openai" || value === "anthropic";
}

async function promptForSecretInput(prompt: string): Promise<string> {
  return requireIo().promptSecret(prompt);
}

async function promptForChoice<T>(
  prompt: string,
  options: Array<{ label: string; value: T; detail?: string }>
): Promise<T | undefined> {
  return requireIo().promptChoice(prompt, options);
}

async function promptForConfirmation(prompt: string, confirmLabel = "Yes", cancelLabel = "No"): Promise<boolean> {
  const selection = await promptForChoice(prompt, [
    {
      label: confirmLabel,
      value: true
    },
    {
      label: cancelLabel,
      value: false
    }
  ]);
  return selection === true;
}

function buildAiProviderStatusPayload(
  provider: CloudImageProvider,
  resolved: { source: CloudCredentialSource; apiKey?: string },
  modelOverride?: string
) {
  return {
    provider,
    configured: Boolean(resolved.apiKey),
    source: resolved.source,
    model: resolveCloudModel(provider, modelOverride)
  };
}

function getConfiguredCliDefaultsLabel(defaults: CliImageEnrichmentDefaults | undefined): string {
  if (!defaults || defaults.mode === "off") {
    return "off";
  }

  if (defaults.mode === "local") {
    return `local (${defaults.provider})`;
  }

  return `cloud (${formatCloudProviderLabel(defaults.cloudProvider)})`;
}

async function connectCloudProviderKey(
  provider: CloudImageProvider,
  cloudKeyStore: KeychainCloudProviderKeyStore,
  cloudKeyResolver: EnvironmentOrStoredCloudKeyResolver,
  imageEnrichmentService: ImageEnrichmentService,
  options?: { quiet?: boolean }
): Promise<void> {
  const providerLabel = formatCloudProviderLabel(provider);
  const apiKey = await promptForSecretInput(`Enter your ${providerLabel} API key`);
  await cloudKeyStore.set(provider, apiKey);
  try {
    await imageEnrichmentService.testCloudProvider(provider);
  } catch (error) {
    const keepKey = await promptForConfirmation(
      `${providerLabel} could not be validated right now (${error instanceof Error ? error.message : String(error)}). Keep the stored key anyway?`,
      "Keep key",
      "Remove key"
    );
    if (!keepKey) {
      await cloudKeyStore.delete(provider);
      throw error;
    }
  }

  const resolved = await cloudKeyResolver.resolve(provider);
  if (!options?.quiet) {
    printText(
      `Configured ${providerLabel} using ${formatCloudCredentialSource(resolved.source)}.${resolved.source === "environment" ? ` ${getProviderEnvVar(provider)} is also set and will take precedence.` : ""}`
    );
  }
}

async function configureLocalImageEnrichmentForCli(
  configStore: CliImageEnrichmentConfigStore,
  existingDefaults: CliImageEnrichmentDefaults | undefined,
  imageEnrichmentService: ImageEnrichmentService,
  parsed: ParsedCliInput
): Promise<boolean> {
  const capabilities = await imageEnrichmentService.inspectCapabilities();
  const options: Array<{ label: string; value: CliImageEnrichmentDefaults["provider"]; detail?: string }> = [];
  if (capabilities.appleVision.available && capabilities.tesseract.available) {
    options.push({
      label: "Use Local OCR (Auto)",
      value: "auto",
      detail: "Apple Vision preferred, Tesseract fallback"
    });
  }
  if (capabilities.appleVision.available) {
    options.push({
      label: "Use Apple Vision",
      value: "apple-vision",
      detail: "Best local OCR quality on macOS"
    });
  }
  if (capabilities.tesseract.available) {
    options.push({
      label: "Use Tesseract",
      value: "tesseract",
      detail: "Cross-platform local OCR"
    });
  }

  if (options.length === 0) {
    throw new Error("No local OCR provider is currently available. Install Tesseract, or use a macOS setup with Apple Vision and the Swift compiler.");
  }

  const provider = await promptForChoice("Choose the local OCR provider to use:", options);
  if (!provider) {
    return false;
  }

  const nextDefaults: CliImageEnrichmentDefaults = {
    ...(existingDefaults || DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS),
    mode: "local",
    provider
  };
  await configStore.write(nextDefaults);
  if (parsed.flags.json) {
    printJsonSuccess(parsed, {
      imageEnrichment: nextDefaults,
      configPath: configStore.getFilePath()
    });
  } else {
    printText(`Saved CLI image enrichment defaults: ${getConfiguredCliDefaultsLabel(nextDefaults)}.`);
  }
  return true;
}

async function configureCloudImageEnrichmentForCli(
  configStore: CliImageEnrichmentConfigStore,
  existingDefaults: CliImageEnrichmentDefaults | undefined,
  cloudKeyStore: KeychainCloudProviderKeyStore,
  cloudKeyResolver: EnvironmentOrStoredCloudKeyResolver,
  imageEnrichmentService: ImageEnrichmentService,
  parsed: ParsedCliInput
): Promise<boolean> {
  const currentDefaultProvider = existingDefaults?.cloudProvider || "openai";
  const provider = await promptForChoice("Choose the cloud provider to use or configure:", [
    {
      label: "OpenAI",
      value: "openai" as const,
      detail: currentDefaultProvider === "openai" ? "current default" : undefined
    },
    {
      label: "Anthropic",
      value: "anthropic" as const,
      detail: currentDefaultProvider === "anthropic" ? "current default" : undefined
    }
  ]);
  if (!provider) {
    return false;
  }

  const resolved = await cloudKeyResolver.resolve(provider);
  const providerLabel = formatCloudProviderLabel(provider);
  const configuredSource = formatCloudCredentialSource(resolved.source);
  const action = await promptForChoice(
    `Choose what to do with ${providerLabel}:`,
    resolved.apiKey
      ? [
          {
            label: `Use ${providerLabel}`,
            value: "use" as const,
            detail: `Configured via ${configuredSource}`
          },
          {
            label: `Test ${providerLabel}`,
            value: "test" as const,
            detail: `Check the configured key with model ${resolveCloudModel(provider, existingDefaults?.cloudModel)}`
          },
          ...(resolved.source === "keychain"
            ? [
                {
                  label: `Reconnect ${providerLabel} API key`,
                  value: "reconnect" as const,
                  detail: "Replace the stored keychain key"
                },
                {
                  label: `Disconnect ${providerLabel} API key`,
                  value: "disconnect" as const,
                  detail: "Remove the stored keychain key"
                }
              ]
            : [
                {
                  label: `Store ${providerLabel} keychain fallback`,
                  value: "reconnect" as const,
                  detail: `${getProviderEnvVar(provider)} currently takes precedence`
                }
              ])
        ]
      : [
          {
            label: `Configure ${providerLabel} API key`,
            value: "configure" as const,
            detail: "Store a key in the OS keychain"
          }
        ]
  );

  if (!action) {
    return false;
  }

  if (action === "configure" || action === "reconnect") {
    await connectCloudProviderKey(provider, cloudKeyStore, cloudKeyResolver, imageEnrichmentService, {
      quiet: parsed.flags.json
    });
  } else if (action === "disconnect") {
    await cloudKeyStore.delete(provider);
    const otherProvider = provider === "openai" ? "anthropic" : "openai";
    const otherResolved = await cloudKeyResolver.resolve(otherProvider);
    const nextDefaults =
      existingDefaults?.mode === "cloud" && existingDefaults.cloudProvider === provider
        ? {
            ...(existingDefaults || DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS),
            mode: otherResolved.apiKey ? ("cloud" as const) : ("off" as const),
            cloudProvider: otherResolved.apiKey ? otherProvider : provider
          }
        : undefined;
    if (nextDefaults) {
      await configStore.write(nextDefaults);
    }
    if (parsed.flags.json) {
      printJsonSuccess(parsed, {
        disconnectedProvider: provider,
        imageEnrichment: nextDefaults || existingDefaults || DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS,
        configPath: configStore.getFilePath()
      });
    } else {
      printText(
        otherResolved.apiKey && nextDefaults?.mode === "cloud"
          ? `Removed the stored ${providerLabel} keychain key. Default cloud provider is now ${formatCloudProviderLabel(otherProvider)}.`
          : `Removed the stored ${providerLabel} keychain key.`
      );
    }
    return true;
  } else if (action === "test") {
    const result = await imageEnrichmentService.testCloudProvider(provider, existingDefaults?.cloudModel);
    if (parsed.flags.json) {
      printJsonSuccess(parsed, {
        provider: result.provider,
        model: result.model,
        source: result.keySource,
        ok: true
      });
    } else {
      printText(
        `${providerLabel} is configured and reachable using ${formatCloudCredentialSource(result.keySource)} with model ${result.model}.`
      );
    }
    return true;
  }

  if (!(await cloudKeyResolver.resolve(provider)).apiKey) {
    if (parsed.flags.json) {
      printJsonSuccess(parsed, {
        cancelled: true,
        reason: `${providerLabel} is not configured, so no cloud defaults were changed.`
      });
    } else {
      printText(`${providerLabel} is not configured, so no cloud defaults were changed.`);
    }
    return true;
  }

  const testResult = await imageEnrichmentService.testCloudProvider(provider, existingDefaults?.cloudModel);
  if (!parsed.flags.json) {
    printText(
      `${providerLabel} is configured and reachable using ${formatCloudCredentialSource(testResult.keySource)} with model ${testResult.model}.`
    );
  }

  const nextDefaults: CliImageEnrichmentDefaults = {
    ...(existingDefaults || DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS),
    mode: "cloud",
    cloudProvider: provider
  };
  await configStore.write(nextDefaults);
  if (parsed.flags.json) {
    printJsonSuccess(parsed, {
      imageEnrichment: nextDefaults,
      configPath: configStore.getFilePath()
    });
  } else {
    printText(`Saved CLI image enrichment defaults: ${getConfiguredCliDefaultsLabel(nextDefaults)}.`);
  }
  return true;
}

async function runCliImageEnrichmentWizard(
  parsed: ParsedCliInput,
  configStore: CliImageEnrichmentConfigStore,
  cloudKeyStore: KeychainCloudProviderKeyStore,
  cloudKeyResolver: EnvironmentOrStoredCloudKeyResolver,
  imageEnrichmentService: ImageEnrichmentService
): Promise<void> {
  const existingDefaults = await configStore.read();
  const openAiStatus = await cloudKeyResolver.resolve("openai");
  const anthropicStatus = await cloudKeyResolver.resolve("anthropic");
  if (!parsed.flags.json) {
    printText(`Current CLI image enrichment: ${getConfiguredCliDefaultsLabel(existingDefaults)}.`);
    printText(
      `Configured providers: OpenAI ${openAiStatus.apiKey ? `(${formatCloudCredentialSource(openAiStatus.source)})` : "(missing)"}, Anthropic ${anthropicStatus.apiKey ? `(${formatCloudCredentialSource(anthropicStatus.source)})` : "(missing)"}.`
    );
  }

  const selection = await promptForChoice("Configure CLI image enrichment:", [
    {
      label: "Use local OCR",
      value: "local" as const,
      detail: "Save local OCR as the CLI default"
    },
    {
      label: "Use cloud AI",
      value: "cloud" as const,
      detail: "Save cloud image enrichment as the CLI default"
    },
    {
      label: "Turn image enrichment off",
      value: "off" as const,
      detail: "Disable saved CLI image enrichment defaults"
    },
    ...(existingDefaults?.mode === "cloud"
      ? [
          {
            label: `Test ${formatCloudProviderLabel(existingDefaults.cloudProvider)}`,
            value: "test" as const,
            detail: `Current default cloud provider • model ${resolveCloudModel(existingDefaults.cloudProvider, existingDefaults.cloudModel)}`
          }
        ]
      : [])
  ]);

  if (!selection) {
    if (parsed.flags.json) {
      printJsonSuccess(parsed, { cancelled: true });
    } else {
      printText("Image enrichment setup cancelled.");
    }
    return;
  }

  if (selection === "local") {
    const saved = await configureLocalImageEnrichmentForCli(configStore, existingDefaults, imageEnrichmentService, parsed);
    if (!saved && parsed.flags.json) {
      printJsonSuccess(parsed, { cancelled: true });
    } else if (!saved) {
      printText("Image enrichment setup cancelled.");
    }
    return;
  }

  if (selection === "cloud") {
    const saved = await configureCloudImageEnrichmentForCli(
      configStore,
      existingDefaults,
      cloudKeyStore,
      cloudKeyResolver,
      imageEnrichmentService,
      parsed
    );
    if (!saved && parsed.flags.json) {
      printJsonSuccess(parsed, { cancelled: true });
    } else if (!saved) {
      printText("Image enrichment setup cancelled.");
    }
    return;
  }

  if (selection === "test") {
    if (!existingDefaults || existingDefaults.mode !== "cloud") {
      if (parsed.flags.json) {
        printJsonSuccess(parsed, { cancelled: true, reason: "No default cloud provider is configured yet." });
      } else {
        printText("No default cloud provider is configured yet.");
      }
      return;
    }

    const result = await imageEnrichmentService.testCloudProvider(existingDefaults.cloudProvider, existingDefaults.cloudModel);
    if (parsed.flags.json) {
      printJsonSuccess(parsed, {
        provider: result.provider,
        model: result.model,
        source: result.keySource,
        ok: true
      });
    } else {
      printText(
        `${formatCloudProviderLabel(result.provider)} is configured and reachable using ${formatCloudCredentialSource(result.keySource)} with model ${result.model}.`
      );
    }
    return;
  }

  const nextDefaults: CliImageEnrichmentDefaults = {
    ...(existingDefaults || DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS),
    mode: "off"
  };
  await configStore.write(nextDefaults);
  if (parsed.flags.json) {
    printJsonSuccess(parsed, {
      imageEnrichment: nextDefaults,
      configPath: configStore.getFilePath()
    });
  } else {
    printText("Saved CLI image enrichment defaults: off.");
  }
}

export async function runCli(rawArgs: string[], runtime: CliRuntime, io: CliIo): Promise<number> {
  currentIo = io;
  currentRuntime = runtime;
  currentExitCode = 0;
  let parsed: ParsedCliInput | undefined;

  try {
    parsed = parseCliInput(rawArgs);
    await runtime.loadDevelopmentEnv(runtime.cwd);

    if (!parsed.command) {
      printUsage();
      return currentExitCode;
    }
    const parsedInput = parsed;

    const workspaceRoot = resolveWorkspaceRoot(parsedInput.flags.cwd);
    const {
      tokenPath,
      authManager,
      driveClient,
      slidesClient,
      cloudKeyStore,
      cloudKeyResolver,
      cliImageEnrichmentConfigStore,
      imageEnrichmentService,
      manifestStore,
      syncManager
    } = runtime.createServices(workspaceRoot);
    const cliProgress =
      parsedInput.flags.json
        ? undefined
        : (message: string) => {
            requireIo().writeStderr(`${message}\n`);
          };

    async function getCliImageEnrichmentSettings(): Promise<ImageEnrichmentSettings | undefined> {
      return resolveCliImageEnrichmentSettings(parsedInput.flags, () => cliImageEnrichmentConfigStore.read());
    }

    if (parsed.command === "auth") {
    if (parsed.subcommand === "login") {
      const connectedAccount = await authManager.connectAccount();
      const authState = await inspectCliAuthState(tokenPath, authManager, driveClient).catch(() => undefined);
      if (parsed.flags.json) {
        printJsonSuccess(parsed, {
          connectedAccount: serializeAccount(connectedAccount, connectedAccount.accountId),
          auth: authState?.auth || { authenticated: true }
        });
      } else {
        printText(
          connectedAccount.accountEmail
            ? `Connected ${connectedAccount.accountEmail}.`
            : `Connected ${connectedAccount.accountId}.`
        );
      }
      return currentExitCode;
    }
    if (parsed.subcommand === "logout") {
      if (parsed.flags.all) {
        const disconnectedCount = await authManager.disconnectAll();
        if (parsed.flags.json) {
          printJsonSuccess(parsed, { disconnectedCount });
        } else {
          printText(
            disconnectedCount === 1 ? "Disconnected 1 Google account." : `Disconnected ${disconnectedCount} Google accounts.`
          );
        }
        return currentExitCode;
      }

      if (!parsed.flags.account) {
        throw new Error("auth logout requires --account <email-or-id> or --all.");
      }

      const disconnectedAccount = await authManager.disconnectAccount(parsed.flags.account);
      if (parsed.flags.json) {
        printJsonSuccess(parsed, {
          disconnected: Boolean(disconnectedAccount),
          account: disconnectedAccount ? serializeAccount(disconnectedAccount) : undefined
        });
      } else {
        printText(
          disconnectedAccount
            ? `Disconnected ${disconnectedAccount.accountEmail || disconnectedAccount.accountId}.`
            : `No connected Google account matched ${parsed.flags.account}.`
        );
      }
      return currentExitCode;
    }
    if (parsed.subcommand === "list") {
      const accounts = await authManager.listAccounts();
      const defaultAccount = await authManager.getDefaultAccount();
      const payload = {
        count: accounts.length,
        defaultAccountId: defaultAccount?.accountId,
        accounts: accounts.map((account) => serializeAccount(account, defaultAccount?.accountId))
      };
      if (parsed.flags.json) {
        printJsonSuccess(parsed, payload);
      } else if (accounts.length === 0) {
        printText("No Google accounts connected.");
      } else {
        for (const account of payload.accounts) {
          printText(`${account.accountEmail || account.accountId}${account.isDefault ? " (default)" : ""}`);
        }
      }
      return currentExitCode;
    }
    if (parsed.subcommand === "use") {
      const accountRef = parsed.args[0];
      if (!accountRef) {
        throw new Error("auth use requires an email or account ID.");
      }

      const defaultAccount = await authManager.setDefaultAccount(accountRef);
      if (parsed.flags.json) {
        printJsonSuccess(parsed, {
          defaultAccount: serializeAccount(defaultAccount, defaultAccount.accountId)
        });
      } else {
        printText(`Default Google account is now ${defaultAccount.accountEmail || defaultAccount.accountId}.`);
      }
      return currentExitCode;
    }
    if (parsed.subcommand === "status") {
      const authInspection = await inspectCliAuthState(tokenPath, authManager, driveClient);
      const accounts = await authManager.listAccounts();
      const defaultAccount = await authManager.getDefaultAccount();
      const payload = {
        ...authInspection.auth,
        connectedAccountCount: accounts.length,
        defaultAccountId: defaultAccount?.accountId,
        accounts: accounts.map((account) => serializeAccount(account, defaultAccount?.accountId))
      };
      if (parsed.flags.json) {
        printJsonSuccess(parsed, payload);
      } else {
        if (!payload.authenticated) {
          printText("No Google accounts connected.");
        } else {
          const parts = [
            payload.connectedAccountCount === 1 ? "1 connected account" : `${payload.connectedAccountCount} connected accounts`,
            defaultAccount?.accountEmail
              ? `default: ${defaultAccount.accountEmail}`
              : defaultAccount
                ? `default: ${defaultAccount.accountId}`
                : undefined,
            payload.scope ? `scope: ${payload.scope}` : undefined
          ].filter(Boolean);
          printText(parts.join(" • "));
        }
      }
      return currentExitCode;
    }

      throw new Error("Use one of: auth login, auth logout, auth list, auth use, auth status");
    }

    if (parsed.command === "ai") {
    if (parsed.subcommand !== "auth") {
      throw new Error("Use one of: ai auth login, ai auth logout, ai auth status, ai auth test");
    }

    if (parsed.nestedSubcommand === "login") {
      const providerArg = parsed.args[0];
      if (!isCloudProvider(providerArg)) {
        throw new Error("ai auth login requires a provider: openai or anthropic.");
      }

      const apiKey = await promptForSecretInput(`Enter your ${formatCloudProviderLabel(providerArg)} API key`);
      await cloudKeyStore.set(providerArg, apiKey);
      const resolved = await cloudKeyResolver.resolve(providerArg);
      const payload = buildAiProviderStatusPayload(providerArg, resolved);
      if (parsed.flags.json) {
        printJsonSuccess(parsed, payload);
      } else {
        printText(
          `Stored ${formatCloudProviderLabel(providerArg)} API key in the OS keychain.${resolved.source === "environment" ? ` ${getProviderEnvVar(providerArg)} is also set and will take precedence.` : ""}`
        );
      }
      return currentExitCode;
    }

    if (parsed.nestedSubcommand === "logout") {
      const providerArg = parsed.args[0];
      if (!isCloudProvider(providerArg)) {
        throw new Error("ai auth logout requires a provider: openai or anthropic.");
      }

      await cloudKeyStore.delete(providerArg);
      const resolved = await cloudKeyResolver.resolve(providerArg);
      const payload = buildAiProviderStatusPayload(providerArg, resolved);
      if (parsed.flags.json) {
        printJsonSuccess(parsed, payload);
      } else if (resolved.source === "environment") {
        printText(
          `Removed the stored ${formatCloudProviderLabel(providerArg)} key from the OS keychain. ${getProviderEnvVar(providerArg)} is still set in the environment and will continue to be used.`
        );
      } else {
        printText(`Removed the stored ${formatCloudProviderLabel(providerArg)} key from the OS keychain.`);
      }
      return currentExitCode;
    }

    if (parsed.nestedSubcommand === "status") {
      const providers: CloudImageProvider[] = ["openai", "anthropic"];
      const statuses = await Promise.all(
        providers.map(async (provider) => buildAiProviderStatusPayload(provider, await cloudKeyResolver.resolve(provider)))
      );
      if (parsed.flags.json) {
        printJsonSuccess(parsed, {
          providers: statuses
        });
      } else {
        for (const status of statuses) {
          printText(
            `${formatCloudProviderLabel(status.provider)}: ${status.configured ? "configured" : "missing"} • ${formatCloudCredentialSource(status.source)} • model ${status.model}`
          );
        }
      }
      return currentExitCode;
    }

    if (parsed.nestedSubcommand === "test") {
      const providerArg = parsed.args[0];
      if (!isCloudProvider(providerArg)) {
        throw new Error("ai auth test requires a provider: openai or anthropic.");
      }

      const result = await imageEnrichmentService.testCloudProvider(providerArg);
      if (parsed.flags.json) {
        printJsonSuccess(parsed, {
          provider: result.provider,
          model: result.model,
          source: result.keySource,
          ok: true
        });
      } else {
        printText(
          `${formatCloudProviderLabel(result.provider)} is configured and reachable using ${formatCloudCredentialSource(result.keySource)} with model ${result.model}.`
        );
      }
      return currentExitCode;
    }

      throw new Error("Use one of: ai auth login, ai auth logout, ai auth status, ai auth test");
    }

    if (parsed.command === "configure") {
    if (parsed.subcommand !== "image-enrichment") {
      throw new Error("Use gdrivesync configure image-enrichment.");
    }

    await runCliImageEnrichmentWizard(
      parsed,
      cliImageEnrichmentConfigStore,
      cloudKeyStore,
      cloudKeyResolver,
      imageEnrichmentService
    );
      return currentExitCode;
    }

    if (parsed.command === "doctor") {
    const report = await runCliDoctor(
      workspaceRoot,
      tokenPath,
      manifestStore,
      authManager,
      driveClient,
      {
        repair: parsed.flags.repair
      },
      imageEnrichmentService,
      cliImageEnrichmentConfigStore
    );
    if (parsed.flags.json) {
      printJsonSuccess(parsed, report);
    } else {
      printText(formatDoctorReport(report));
    }
    if (report.issues.some((issue) => issue.severity === "error") && !report.repair.performed) {
      markFailure();
    }
      return currentExitCode;
    }

    if (parsed.command === "inspect" || parsed.command === "metadata") {
    const rawInput = parsed.args[0];
    const parsedInput = rawInput ? parseGoogleDocInput(rawInput) : undefined;
    if (!parsedInput) {
      throw new Error("Pass a Google Docs, Slides, Sheets, Drive, DOCX, PPTX, or XLSX file URL or raw file ID.");
    }

    const { accessToken } = await authManager.getAccessToken(parsed.flags.account);
    const metadata = await driveClient.getFileMetadata(accessToken, {
      fileId: parsedInput.fileId,
      resourceKey: parsedInput.resourceKey,
      expectedMimeTypes: undefined,
      sourceTypeLabel: "Google file"
    });
    const syncProfile = resolveSyncProfileForMimeType(metadata.mimeType);
    if (parsed.command === "metadata") {
      printJsonSuccess(parsed, {
        ...metadata,
        account: parsed.flags.account || undefined
      });
      return currentExitCode;
    }

    printJsonSuccess(parsed, {
      fileId: metadata.id,
      title: metadata.name,
      account: parsed.flags.account || undefined,
      sourceMimeType: metadata.mimeType,
      sourceUrl: metadata.webViewLink || syncProfile?.buildSourceUrl(metadata.id) || parsedInput.sourceUrl,
      profileId: syncProfile?.id,
      sourceTypeLabel: syncProfile?.sourceTypeLabel,
      targetFamily: syncProfile?.targetFamily,
      targetFileExtension: syncProfile?.targetFileExtension,
      retrievalMode: syncProfile?.retrievalMode
    });
      return currentExitCode;
    }

    if (parsed.command === "export") {
    const [rawInput, outputPath] = parsed.args;
    if (!rawInput) {
      throw new Error("export requires a Google file URL or ID.");
    }

    const parsedInput = parseGoogleDocInput(rawInput);
    if (!parsedInput) {
      throw new Error("Pass a Google Docs, Slides, Sheets, Drive, DOCX, PPTX, or XLSX file URL or raw file ID.");
    }

    const { accessToken } = await authManager.getAccessToken(parsed.flags.account);
    const metadata = await driveClient.getFileMetadata(accessToken, {
      fileId: parsedInput.fileId,
      resourceKey: parsedInput.resourceKey,
      expectedMimeTypes: undefined,
      sourceTypeLabel: "Google file"
    });
    const syncProfile = resolveSyncProfileForMimeType(metadata.mimeType);
    if (!syncProfile) {
      throw new Error("This Google file is not supported for export.");
    }

    const resolvedOutputPath = outputPath ? resolveLocalPath(workspaceRoot, outputPath) : undefined;
    if (resolvedOutputPath) {
      const extension = path.extname(resolvedOutputPath).toLowerCase();
      if (syncProfile.targetFamily === "markdown" && extension !== ".md") {
        throw new Error("Markdown exports must target a .md path.");
      }
      if (syncProfile.targetFamily === "csv" && extension !== ".csv") {
        throw new Error("Spreadsheet exports must target a .csv path.");
      }
    }

    const imageEnrichmentSettings = await getCliImageEnrichmentSettings();
    const exportResult = await syncManager.exportSelection(
      {
        profileId: syncProfile.id,
        fileId: metadata.id,
        title: metadata.name,
        sourceUrl: metadata.webViewLink || syncProfile.buildSourceUrl(metadata.id),
        sourceMimeType: metadata.mimeType,
        resourceKey: metadata.resourceKey || parsedInput.resourceKey,
        accountId: parsed.flags.account
      },
      {
        targetPath: resolvedOutputPath,
        includePresentationBackgrounds: parsed.flags.includeBackgrounds,
        imageEnrichmentSettings,
        progress: cliProgress
      }
    );

    if (!resolvedOutputPath) {
      if (exportResult.primaryText === undefined) {
        throw new Error("This export did not produce a single text output.");
      }
      if (parsed.flags.json) {
        printJsonSuccess(parsed, {
          outputKind: exportResult.outputKind,
          text: exportResult.primaryText
        });
      } else {
        requireIo().writeStdout(exportResult.primaryText);
      }
      return currentExitCode;
    }

    if (parsed.flags.json) {
      printJsonSuccess(parsed, {
        targetPath: resolvedOutputPath,
        outputKind: exportResult.outputKind,
        message: exportResult.message,
        writtenPaths: exportResult.writtenPaths,
        generatedDirectoryPath: exportResult.generatedDirectoryPath
      });
    } else {
      printText(exportResult.message);
    }
      return currentExitCode;
    }

    if (parsed.command === "link") {
    const [rawInput, localPathArg] = parsed.args;
    if (!rawInput || !localPathArg) {
      throw new Error("link requires a Google file URL or ID and a local target path.");
    }

    const imageEnrichmentSettings = await getCliImageEnrichmentSettings();
    const localPath = resolveLocalPath(workspaceRoot, localPathArg);
    const selection = await syncManager.resolveSelectionFromInput(rawInput, localPath, parsed.flags.account);
    const outcome = await syncManager.linkFile(localPath, selection, {
      force: parsed.flags.force,
      accountId: parsed.flags.account,
      imageEnrichmentSettings,
      progress: cliProgress
    });
    if (parsed.flags.json) {
      printJsonSuccess(parsed, {
        targetPath: localPath,
        manifestPath: manifestStore.getManifestPath(),
        outcome
      });
    } else {
      printText(outcome.message);
    }
    if (outcome.status === "cancelled") {
      markFailure();
    }
      return currentExitCode;
    }

    if (parsed.command === "status") {
    if (parsed.flags.all) {
      const linkedFiles = await manifestStore.listLinkedFiles();
      const files = await Promise.all(linkedFiles.map((item) => describeLinkedFile(manifestStore, item.filePath)));
      if (parsed.flags.json) {
        printJsonSuccess(parsed, {
          rootPath: workspaceRoot,
          manifestPath: manifestStore.getManifestPath(),
          count: files.length,
          files
        });
      } else {
        printText(`${files.length} linked files in ${manifestStore.getManifestPath()}`);
      }
      return currentExitCode;
    }

    const localPathArg = parsed.args[0];
    if (!localPathArg) {
      throw new Error("status requires a local path or --all.");
    }
    const localPath = resolveLocalPath(workspaceRoot, localPathArg);
    const status = await describeLinkedFile(manifestStore, localPath);
    if (parsed.flags.json) {
      printJsonSuccess(parsed, status);
    } else {
      printText(
        status.linked
          ? `Linked: ${String((status as { entry?: { title?: string } }).entry?.title || localPath)}`
          : `Not linked: ${localPath}`
      );
    }
      return currentExitCode;
    }

    if (parsed.command === "sync") {
    const imageEnrichmentSettings = await getCliImageEnrichmentSettings();
    if (parsed.flags.all) {
      const summary = await syncManager.syncAll({
        force: parsed.flags.force,
        accountId: parsed.flags.account,
        imageEnrichmentSettings,
        progress: cliProgress
      });
      if (parsed.flags.json) {
        printJsonSuccess(parsed, {
          rootPath: workspaceRoot,
          manifestPath: manifestStore.getManifestPath(),
          ...summary
        });
      } else {
        printText(buildCliSyncAllSummary(summary));
      }
      if (summary.cancelledCount > 0 || summary.failedCount > 0) {
        markFailure();
      }
        return currentExitCode;
    }

    const localPathArg = parsed.args[0];
    if (!localPathArg) {
      throw new Error("sync requires a local path or --all.");
    }
    const localPath = resolveLocalPath(workspaceRoot, localPathArg);
    const outcome = await syncManager.syncFile(localPath, {
      force: parsed.flags.force,
      accountId: parsed.flags.account,
      imageEnrichmentSettings,
      progress: cliProgress
    });
    if (parsed.flags.json) {
      printJsonSuccess(parsed, {
        targetPath: localPath,
        outcome
      });
    } else {
      printText(outcome.message);
    }
    if (outcome.status === "cancelled") {
      markFailure();
    }
      return currentExitCode;
    }

    if (parsed.command === "unlink") {
    const localPathArg = parsed.args[0];
    if (!localPathArg) {
      throw new Error("unlink requires a local path.");
    }
    const localPath = resolveLocalPath(workspaceRoot, localPathArg);
    const removed = await syncManager.unlinkFile(localPath, {
      removeGeneratedFiles: parsed.flags.removeGenerated
    });
    if (parsed.flags.json) {
      printJsonSuccess(parsed, {
        targetPath: localPath,
        removed
      });
    } else {
      printText(removed ? `Unlinked ${localPath}` : `No linked file found for ${localPath}`);
    }
      return currentExitCode;
    }

    printUsage();
    return currentExitCode;
  } catch (error) {
    if (rawArgs.includes("--json")) {
      printJson({
        ok: false,
        contractVersion: CLI_JSON_CONTRACT_VERSION,
        command: parsed ? getCommandLabel(parsed) : "unknown",
        error: buildCliErrorPayload(error)
      });
    } else {
      const payload = buildCliErrorPayload(error);
      requireIo().writeStderr(`${payload.message}\n`);
    }
    return 1;
  } finally {
    currentIo = undefined;
    currentRuntime = undefined;
  }
}
