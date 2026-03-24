#!/usr/bin/env node

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";

import { CliManifestStore } from "./cliManifestStore";
import { CliSyncManager } from "./cliSync";
import { DriveClient } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { loadDevelopmentEnv, resolveCliGoogleConfig } from "./runtimeConfig";
import { SlidesClient } from "./slidesClient";
import { resolveSyncProfileForMimeType } from "./syncProfiles";
import { FileTokenStore } from "./tokenStores";
import { buildCliSyncAllSummary } from "./utils/cliSyncSummary";
import { parseGoogleDocInput } from "./utils/docUrl";
import { fromManifestKey } from "./utils/paths";

interface CliFlags {
  json: boolean;
  all: boolean;
  force: boolean;
  removeGenerated: boolean;
  cwd?: string;
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
  gdrivesync auth logout
  gdrivesync auth status [--json]
  gdrivesync inspect <google-file-url-or-id> [--json]
  gdrivesync metadata <google-file-url-or-id> [--json]
  gdrivesync export <google-file-url-or-id> [output-path] [--json]
  gdrivesync link <google-file-url-or-id> <local-path> [--cwd path] [--json] [--force]
  gdrivesync status <local-path> [--cwd path] [--json]
  gdrivesync status --all [--cwd path] [--json]
  gdrivesync sync <local-path> [--cwd path] [--json] [--force]
  gdrivesync sync --all [--cwd path] [--json] [--force]
  gdrivesync unlink <local-path> [--cwd path] [--json] [--remove-generated]

Flags:
  --json              Emit machine-readable JSON
  --cwd <path>        Workspace root to use for manifest operations
  --all               Target every linked file in the manifest
  --force             Overwrite local changes during sync
  --remove-generated  Remove tracked generated files when unlinking
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
    removeGenerated: false
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
    if (arg === "--force" || arg === "--yes") {
      flags.force = true;
      continue;
    }
    if (arg === "--remove-generated") {
      flags.removeGenerated = true;
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
  const generatedFiles = linkedFile.entry.generatedFiles || linkedFile.entry.generatedFilePaths || [];

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
      syncOnOpen: linkedFile.entry.syncOnOpen,
      lastSyncedAt: linkedFile.entry.lastSyncedAt,
      lastDriveVersion: linkedFile.entry.lastDriveVersion,
      generatedFileCount: generatedFiles.length
    }
  };
}

async function main(): Promise<void> {
  await loadDevelopmentEnv(process.cwd());

  const parsed = parseCliInput(process.argv.slice(2));
  if (!parsed.command) {
    printUsage();
    return;
  }

  const tokenStore = new FileTokenStore(path.join(os.homedir(), ".gdrivesync-dev-session.json"));
  const authManager = new GoogleAuthManager(tokenStore, resolveCliGoogleConfig, openExternalUrl);
  const driveClient = new DriveClient();
  const slidesClient = new SlidesClient();
  const workspaceRoot = resolveWorkspaceRoot(parsed.flags.cwd);
  const manifestStore = new CliManifestStore(workspaceRoot);
  const syncManager = new CliSyncManager(authManager, driveClient, manifestStore, slidesClient);

  if (parsed.command === "auth") {
    if (parsed.subcommand === "login") {
      await authManager.signIn();
      if (parsed.flags.json) {
        printJson({ authenticated: true });
      } else {
        printText("Signed in.");
      }
      return;
    }
    if (parsed.subcommand === "logout") {
      await authManager.signOut();
      if (parsed.flags.json) {
        printJson({ authenticated: false });
      } else {
        printText("Signed out.");
      }
      return;
    }
    if (parsed.subcommand === "status") {
      const session = await tokenStore.get();
      const payload = session
        ? {
            authenticated: true,
            expiresAt: new Date(session.expiresAt).toISOString(),
            expiresInSeconds: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
            scope: session.scope,
            refreshTokenPresent: Boolean(session.refreshToken)
          }
        : {
            authenticated: false
          };
      if (parsed.flags.json) {
        printJson(payload);
      } else {
        printText(payload.authenticated ? `Signed in. Scope: ${payload.scope}` : "Not signed in.");
      }
      return;
    }

    throw new Error("Use one of: auth login, auth logout, auth status");
  }

  if (parsed.command === "sign-in") {
    await authManager.signIn();
    printText("Signed in.");
    return;
  }

  if (parsed.command === "sign-out") {
    await authManager.signOut();
    printText("Signed out.");
    return;
  }

  if (parsed.command === "inspect" || parsed.command === "metadata") {
    const rawInput = parsed.args[0];
    const parsedInput = rawInput ? parseGoogleDocInput(rawInput) : undefined;
    if (!parsedInput) {
      throw new Error("Pass a Google Docs, Slides, Sheets, Drive, DOCX, PPTX, or XLSX file URL or raw file ID.");
    }

    const accessToken = await authManager.getAccessToken();
    const metadata = await driveClient.getFileMetadata(accessToken, {
      fileId: parsedInput.fileId,
      resourceKey: parsedInput.resourceKey,
      expectedMimeTypes: undefined,
      sourceTypeLabel: "Google file"
    });
    const syncProfile = resolveSyncProfileForMimeType(metadata.mimeType);
    if (parsed.command === "metadata") {
      printJson(metadata);
      return;
    }

    printJson({
      fileId: metadata.id,
      title: metadata.name,
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

    const accessToken = await authManager.getAccessToken();
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
        resourceKey: metadata.resourceKey || parsedInput.resourceKey
      },
      {
        targetPath: resolvedOutputPath
      }
    );

    if (!resolvedOutputPath) {
      if (exportResult.primaryText === undefined) {
        throw new Error("This export did not produce a single text output.");
      }
      if (parsed.flags.json) {
        printJson({
          outputKind: exportResult.outputKind,
          text: exportResult.primaryText
        });
      } else {
        process.stdout.write(exportResult.primaryText);
      }
      return;
    }

    if (parsed.flags.json) {
      printJson({
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
    const selection = await syncManager.resolveSelectionFromInput(rawInput, localPath);
    const outcome = await syncManager.linkFile(localPath, selection, { force: parsed.flags.force });
    if (parsed.flags.json) {
      printJson({
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
        printJson({
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
      printJson(status);
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
      const summary = await syncManager.syncAll({ force: parsed.flags.force });
      if (parsed.flags.json) {
        printJson({
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
    const outcome = await syncManager.syncFile(localPath, { force: parsed.flags.force });
    if (parsed.flags.json) {
      printJson({
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
      printJson({
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

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.slice(2).includes("--json")) {
    printJson({
      error: {
        message
      }
    });
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = 1;
});
