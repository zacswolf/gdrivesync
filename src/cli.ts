#!/usr/bin/env node

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";

import { inspectCliAuthState, formatDoctorReport, runCliDoctor } from "./cliDoctor";
import { CliManifestStore } from "./cliManifestStore";
import { CliSyncManager } from "./cliSync";
import { DriveClient, GoogleApiError, PickerGrantRequiredError } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { resolveDefaultCliCacheRoot } from "./appleVisionOcr";
import { ImageEnrichmentService, ImageEnrichmentSettings } from "./imageEnrichment";
import { loadDevelopmentEnv, resolveCliGoogleConfig } from "./runtimeConfig";
import { SlidesClient } from "./slidesClient";
import { CorruptStateError } from "./stateErrors";
import { resolveSyncProfileForMimeType } from "./syncProfiles";
import { FileOAuthStateStore } from "./tokenStores";
import { buildCliSyncAllSummary } from "./utils/cliSyncSummary";
import { parseGoogleDocInput } from "./utils/docUrl";
import { fromManifestKey } from "./utils/paths";
import { ConnectedGoogleAccount } from "./types";

const CLI_JSON_CONTRACT_VERSION = 1;

interface CliFlags {
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
  imageEnrichmentStore?: ImageEnrichmentSettings["store"];
}

interface ParsedCliInput {
  command: string;
  subcommand?: string;
  args: string[];
  flags: CliFlags;
}

function printUsage(): void {
  process.stdout.write(`Usage:
  gdrivesync auth login
  gdrivesync auth logout --account <account>
  gdrivesync auth logout --all
  gdrivesync auth list [--json]
  gdrivesync auth use <account> [--json]
  gdrivesync auth status [--json]
  gdrivesync doctor [--cwd path] [--json] [--repair]
  gdrivesync inspect <google-file-url-or-id> [--json]
  gdrivesync metadata <google-file-url-or-id> [--json]
  gdrivesync export <google-file-url-or-id> [output-path] [--json] [--include-backgrounds] [--image-enrichment off|local] [--image-enrichment-provider auto|apple-vision|tesseract] [--image-enrichment-store alt-plus-comment|alt-only]
  gdrivesync link <google-file-url-or-id> <local-path> [--cwd path] [--json] [--force] [--image-enrichment off|local] [--image-enrichment-provider auto|apple-vision|tesseract] [--image-enrichment-store alt-plus-comment|alt-only]
  gdrivesync status <local-path> [--cwd path] [--json]
  gdrivesync status --all [--cwd path] [--json]
  gdrivesync sync <local-path> [--cwd path] [--json] [--force] [--image-enrichment off|local] [--image-enrichment-provider auto|apple-vision|tesseract] [--image-enrichment-store alt-plus-comment|alt-only]
  gdrivesync sync --all [--cwd path] [--json] [--force] [--image-enrichment off|local] [--image-enrichment-provider auto|apple-vision|tesseract] [--image-enrichment-store alt-plus-comment|alt-only]
  gdrivesync unlink <local-path> [--cwd path] [--json] [--remove-generated]

Flags:
  --json              Emit machine-readable JSON
  --cwd <path>        Workspace root to use for manifest operations
  --all               Target every linked file in the manifest
  --account <value>   Google account email or account ID to target
  --force             Overwrite local changes during sync
  --remove-generated   Remove tracked generated files when unlinking
  --include-backgrounds  For oversized Google Slides decks that fall back to the Slides API, include slide background images
  --image-enrichment   Control local image OCR enrichment for Markdown/Marp outputs (off or local)
  --image-enrichment-provider  Choose the local OCR provider (auto, apple-vision, or tesseract)
  --image-enrichment-store  Store OCR as rewritten alt text only or alt text plus HTML comments
  --repair            Let doctor back up corrupt local state and restore a working baseline
`);
}

function openExternalUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const command =
      process.platform === "darwin"
        ? { bin: "open", args: [url] }
        : process.platform === "win32"
          ? { bin: "cmd", args: ["/c", "start", "", url] }
          : { bin: "xdg-open", args: [url] };

    const child = spawn(command.bin, command.args, {
      stdio: "ignore",
      detached: process.platform !== "win32"
    });
    child.on("error", () => resolve(false));
    child.unref();
    resolve(true);
  });
}

function parseCliInput(rawArgs: string[]): ParsedCliInput {
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
      if (value !== "off" && value !== "local") {
        throw new Error("--image-enrichment requires off or local.");
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

  return {
    command,
    args: [maybeSubcommand, ...rest].filter((value): value is string => Boolean(value)),
    flags
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function getCommandLabel(parsed: ParsedCliInput): string {
  if (parsed.command === "auth") {
    return `auth.${parsed.subcommand || "unknown"}`;
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

function buildCliErrorPayload(error: unknown): {
  code: string;
  message: string;
  recoverable: boolean;
  advice?: string;
  path?: string;
} {
  if (error instanceof CorruptStateError) {
    return {
      code: error.kind === "manifest" ? "MANIFEST_CORRUPT" : "AUTH_SESSION_CORRUPT",
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
  if (message.includes("requires a") || message.includes("must target") || message.includes("Pass a ")) {
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

  return {
    code: "UNKNOWN_ERROR",
    message,
    recoverable: false
  };
}

function printText(value: string): void {
  process.stdout.write(`${value}\n`);
}

function markFailure(): void {
  process.exitCode = 1;
}

function resolveWorkspaceRoot(cwdFlag: string | undefined): string {
  return path.resolve(cwdFlag || process.cwd());
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

function resolveCliImageEnrichmentSettings(flags: CliFlags): ImageEnrichmentSettings | undefined {
  const inferredMode =
    flags.imageEnrichmentMode ||
    (flags.imageEnrichmentProvider || flags.imageEnrichmentStore ? "local" : "off");
  if (inferredMode !== "local") {
    return undefined;
  }

  return {
    mode: "local",
    provider: flags.imageEnrichmentProvider || "auto",
    store: flags.imageEnrichmentStore || "alt-plus-comment",
    onlyWhenAltGeneric: true
  };
}

async function main(): Promise<void> {
  await loadDevelopmentEnv(process.cwd());

  const parsed = parseCliInput(process.argv.slice(2));
  if (!parsed.command) {
    printUsage();
    return;
  }

  const tokenPath = path.join(os.homedir(), ".gdrivesync-dev-session.json");
  const tokenStore = new FileOAuthStateStore(tokenPath);
  const authManager = new GoogleAuthManager(tokenStore, resolveCliGoogleConfig, openExternalUrl);
  const driveClient = new DriveClient();
  const slidesClient = new SlidesClient();
  const imageEnrichmentService = new ImageEnrichmentService(
    resolveDefaultCliCacheRoot(),
    path.resolve(__dirname, "../resources/appleVisionOcr.swift")
  );
  const workspaceRoot = resolveWorkspaceRoot(parsed.flags.cwd);
  const manifestStore = new CliManifestStore(workspaceRoot);
  const syncManager = new CliSyncManager(authManager, driveClient, manifestStore, slidesClient, imageEnrichmentService);
  const imageEnrichmentSettings = resolveCliImageEnrichmentSettings(parsed.flags);
  const cliProgress =
    parsed.flags.json
      ? undefined
      : (message: string) => {
          process.stderr.write(`${message}\n`);
        };

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
      return;
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
        return;
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
      return;
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
      return;
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
      return;
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
      return;
    }

    throw new Error("Use one of: auth login, auth logout, auth list, auth use, auth status");
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
      imageEnrichmentService
    );
    if (parsed.flags.json) {
      printJsonSuccess(parsed, report);
    } else {
      printText(formatDoctorReport(report));
    }
    if (report.issues.some((issue) => issue.severity === "error") && !report.repair.performed) {
      markFailure();
    }
    return;
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
      return;
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
    return;
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
        process.stdout.write(exportResult.primaryText);
      }
      return;
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
    return;
  }

  if (parsed.command === "link") {
    const [rawInput, localPathArg] = parsed.args;
    if (!rawInput || !localPathArg) {
      throw new Error("link requires a Google file URL or ID and a local target path.");
    }

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
    return;
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
      return;
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
    return;
  }

    if (parsed.command === "sync") {
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
      return;
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
    return;
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
    return;
  }

  printUsage();
}

const parsedInput = parseCliInput(process.argv.slice(2));

void main().catch((error) => {
  if (process.argv.slice(2).includes("--json")) {
    printJson({
      ok: false,
      contractVersion: CLI_JSON_CONTRACT_VERSION,
      command: getCommandLabel(parsedInput),
      error: buildCliErrorPayload(error)
    });
  } else {
    const payload = buildCliErrorPayload(error);
    process.stderr.write(`${payload.message}\n`);
  }
  process.exitCode = 1;
});
