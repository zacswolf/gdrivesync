import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { CliManifestStore } from "./cliManifestStore";
import { convertDocxToMarkdown } from "./docxConverter";
import { DriveClient } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { LocalFileState, needsOverwriteConfirmation } from "./overwritePolicy";
import { convertPresentationToMarp } from "./presentationConverter";
import { getSyncProfile, getSyncProfilesForTargetFamily, resolveSyncProfileForMimeType } from "./syncProfiles";
import {
  GeneratedFilePayload,
  GeneratedFileRecord,
  LinkedFileContext,
  LinkedFileEntry,
  PickerSelection,
  SyncOutcome,
  SyncOutputKind
} from "./types";
import { sha256Bytes, sha256Text } from "./utils/hash";
import { containsEmbeddedImageData, extractMarkdownAssets } from "./utils/markdownAssets";
import { fromManifestKey } from "./utils/paths";
import { buildSpreadsheetSyncSummary } from "./utils/spreadsheetSyncSummary";
import { parseWorkbookToCsvOutput } from "./workbookCsv";

interface TrackedOutputState {
  hasMissing: boolean;
  hasModified: boolean;
}

interface CliSyncOptions {
  force?: boolean;
}

export interface CliFailedSyncOutcome {
  status: "failed";
  message: string;
}

export type CliSyncOutcome = SyncOutcome | CliFailedSyncOutcome;

export interface CliBatchSyncResult {
  results: Array<{ file: string; outcome: CliSyncOutcome }>;
  syncedCount: number;
  skippedCount: number;
  cancelledCount: number;
  failedCount: number;
}

export interface CliExportResult {
  targetPath?: string;
  outputKind: SyncOutputKind;
  message: string;
  primaryText?: string;
  writtenPaths: string[];
  generatedDirectoryPath?: string;
}

export class CliSyncManager {
  constructor(
    private readonly authManager: GoogleAuthManager,
    private readonly driveClient: DriveClient,
    private readonly manifestStore: CliManifestStore
  ) {}

  getAllowedProfilesForTargetPath(targetPath: string) {
    const lowerPath = targetPath.toLowerCase();
    if (lowerPath.endsWith(".md")) {
      return getSyncProfilesForTargetFamily("markdown");
    }
    if (lowerPath.endsWith(".csv")) {
      return getSyncProfilesForTargetFamily("csv");
    }

    throw new Error("Local targets must end in .md or .csv.");
  }

  async resolveSelectionFromInput(rawInput: string, targetPath: string): Promise<PickerSelection> {
    const { parseGoogleDocInput } = await import("./utils/docUrl");
    const parsedInput = parseGoogleDocInput(rawInput);
    if (!parsedInput) {
      throw new Error("Pass a Google Docs, Slides, Sheets, Drive, DOCX, PPTX, or XLSX file URL or raw file ID.");
    }

    const allowedProfiles = this.getAllowedProfilesForTargetPath(targetPath);
    const accessToken = await this.authManager.getAccessToken();
    const metadata = await this.driveClient.getFileMetadata(accessToken, {
      fileId: parsedInput.fileId,
      resourceKey: parsedInput.resourceKey,
      expectedMimeTypes: allowedProfiles.map((profile) => profile.sourceMimeType),
      sourceTypeLabel: "supported Google file"
    });
    const resolvedProfile = resolveSyncProfileForMimeType(metadata.mimeType);
    if (!resolvedProfile || !allowedProfiles.some((profile) => profile.id === resolvedProfile.id)) {
      throw new Error(`This Google file cannot sync to the selected ${path.extname(targetPath)} target.`);
    }

    return {
      profileId: resolvedProfile.id,
      fileId: metadata.id,
      title: metadata.name,
      sourceUrl: metadata.webViewLink || resolvedProfile.buildSourceUrl(metadata.id),
      sourceMimeType: metadata.mimeType,
      resourceKey: metadata.resourceKey || parsedInput.resourceKey
    };
  }

  async linkFile(filePath: string, selection: PickerSelection, options: CliSyncOptions = {}): Promise<SyncOutcome> {
    const profile = getSyncProfile(selection.profileId);
    await this.manifestStore.linkFile(filePath, {
      profileId: selection.profileId,
      fileId: selection.fileId,
      sourceUrl: selection.sourceUrl,
      sourceMimeType: selection.sourceMimeType || profile.sourceMimeType,
      exportMimeType: profile.exportMimeType,
      localFormat: profile.localFormat,
      outputKind: "file",
      resourceKey: selection.resourceKey,
      title: selection.title,
      syncOnOpen: false,
      generatedFiles: undefined,
      generatedFilePaths: undefined,
      lastDriveVersion: undefined,
      lastLocalHash: undefined,
      lastSyncedAt: undefined
    });
    return this.syncFile(filePath, options);
  }

  async syncFile(filePath: string, options: CliSyncOptions = {}): Promise<SyncOutcome> {
    const linkedFile = await this.manifestStore.getLinkedFile(filePath);
    if (!linkedFile) {
      throw new Error("This file is not linked to a Google source yet.");
    }

    return this.doSyncFile(linkedFile, options);
  }

  async syncAll(options: CliSyncOptions = {}): Promise<CliBatchSyncResult> {
    const linkedFiles = await this.manifestStore.listLinkedFiles();
    const results: Array<{ file: string; outcome: CliSyncOutcome }> = [];
    let syncedCount = 0;
    let skippedCount = 0;
    let cancelledCount = 0;
    let failedCount = 0;

    for (const linkedFile of linkedFiles) {
      let outcome: CliSyncOutcome;
      try {
        outcome = await this.syncFile(linkedFile.filePath, options);
      } catch (error) {
        failedCount += 1;
        outcome = {
          status: "failed",
          message: this.toErrorMessage(error)
        };
      }

      if (outcome.status === "synced") {
        syncedCount += 1;
      } else if (outcome.status === "skipped") {
        skippedCount += 1;
      } else if (outcome.status === "cancelled") {
        cancelledCount += 1;
      }

      results.push({
        file: linkedFile.filePath,
        outcome
      });
    }

    return { results, syncedCount, skippedCount, cancelledCount, failedCount };
  }

  async unlinkFile(filePath: string, options?: { removeGeneratedFiles?: boolean }): Promise<boolean> {
    const context = await this.manifestStore.getLinkedFile(filePath);
    if (!context) {
      return false;
    }

    const baseTargetPath = this.getBaseTargetPath(context);
    if (options?.removeGeneratedFiles) {
      await this.syncGeneratedFiles(baseTargetPath, this.getTrackedGeneratedFilePaths(context.entry), []);
      if (context.entry.outputKind === "file" && context.matchedOutputKind === "primary") {
        await this.deletePrimaryFile(baseTargetPath);
      }
    }

    return this.manifestStore.unlinkFile(filePath);
  }

  async exportSelection(selection: PickerSelection, options?: { targetPath?: string }): Promise<CliExportResult> {
    const profile = getSyncProfile(selection.profileId);
    const accessToken = await this.authManager.getAccessToken();
    const metadata = await this.driveClient.getFileMetadata(accessToken, {
      fileId: selection.fileId,
      resourceKey: selection.resourceKey,
      expectedMimeTypes: [selection.sourceMimeType || profile.sourceMimeType],
      sourceTypeLabel: profile.sourceTypeLabel
    });

    if (profile.targetFamily === "csv") {
      const workbookBytes = await this.fetchWorkbookBytes(accessToken, selection.fileId, selection.resourceKey, profile);
      const baseTargetPath =
        options?.targetPath ||
        path.join(process.cwd(), `${this.slugifyTitle(metadata.name || selection.title || "spreadsheet")}.csv`);
      const workbookOutput = parseWorkbookToCsvOutput(baseTargetPath, workbookBytes);

      if (!options?.targetPath) {
        if (workbookOutput.outputKind !== "file" || workbookOutput.primaryFileText === undefined) {
          throw new Error("This spreadsheet has multiple visible worksheets. Pass an output path to export it as files.");
        }

        return {
          outputKind: "file",
          message: `Exported ${metadata.name} to stdout.`,
          primaryText: workbookOutput.primaryFileText,
          writtenPaths: []
        };
      }

      if (workbookOutput.outputKind === "directory") {
        await this.syncGeneratedFiles(baseTargetPath, undefined, workbookOutput.generatedFiles);
        await this.deletePrimaryFile(baseTargetPath);
        return {
          targetPath: options.targetPath,
          outputKind: "directory",
          message: `Exported ${metadata.name} to ${path.parse(options.targetPath).name}/`,
          writtenPaths: workbookOutput.generatedFiles.map((generatedFile) =>
            path.join(path.dirname(baseTargetPath), ...generatedFile.relativePath.split("/"))
          ),
          generatedDirectoryPath: path.join(path.dirname(baseTargetPath), path.parse(baseTargetPath).name)
        };
      }

      const primaryText = workbookOutput.primaryFileText || "";
      await this.writeTextFile(options.targetPath, primaryText);
      return {
        targetPath: options.targetPath,
        outputKind: "file",
        message: `Exported ${metadata.name} to ${path.basename(options.targetPath)}.`,
        primaryText,
        writtenPaths: [options.targetPath]
      };
    }

    const exportMarkdownPath =
      options?.targetPath ||
      `${this.slugifyTitle(metadata.name || selection.title || (profile.localFormat === "marp" ? "presentation" : "document"))}.md`;
    const markdownResult =
      profile.localFormat === "marp"
        ? await convertPresentationToMarp(
            exportMarkdownPath,
            await this.fetchPresentationBytes(accessToken, selection.fileId, selection.resourceKey, profile),
            {
              assetMode: options?.targetPath ? "external" : "data-uri",
              title: metadata.name || selection.title
            }
          )
        : extractMarkdownAssets(
            exportMarkdownPath,
            await this.fetchSourceMarkdown(accessToken, selection.fileId, selection.resourceKey, profile)
          );
    if (!options?.targetPath) {
      return {
        outputKind: "file",
        message: `Exported ${metadata.name} to stdout.`,
        primaryText: markdownResult.markdown,
        writtenPaths: []
      };
    }

    const targetPath = options.targetPath;
    await this.syncGeneratedFiles(targetPath, undefined, markdownResult.assets);
    await this.writeTextFile(targetPath, markdownResult.markdown);
    return {
      targetPath,
      outputKind: "file",
      message: `Exported ${metadata.name} to ${path.basename(targetPath)}.`,
      primaryText: markdownResult.markdown,
      writtenPaths: [
        targetPath,
        ...markdownResult.assets.map((asset) => path.join(path.dirname(targetPath), ...asset.relativePath.split("/")))
      ]
    };
  }

  private async doSyncFile(linkedFile: LinkedFileContext, options: CliSyncOptions): Promise<SyncOutcome> {
    const profile = getSyncProfile(linkedFile.entry.profileId);
    const accessToken = await this.authManager.getAccessToken();
    const baseTargetPath = this.getBaseTargetPath(linkedFile);
    const metadata = await this.driveClient.getFileMetadata(accessToken, {
      fileId: linkedFile.entry.fileId,
      resourceKey: linkedFile.entry.resourceKey,
      expectedMimeTypes: [linkedFile.entry.sourceMimeType],
      sourceTypeLabel: profile.sourceTypeLabel
    });

    if (profile.targetFamily === "csv") {
      return this.doSpreadsheetSync(baseTargetPath, linkedFile, profile, metadata, accessToken, options);
    }

    const localText = await this.readLocalFileText(baseTargetPath);
    const needsAssetMigration = profile.localFormat === "markdown" && localText ? containsEmbeddedImageData(localText) : false;
    const trackedGeneratedFiles = await this.inspectTrackedGeneratedFiles(baseTargetPath, linkedFile.entry);
    const trackedAssetsNeedRepair = trackedGeneratedFiles.hasMissing || trackedGeneratedFiles.hasModified;
    if (
      linkedFile.entry.lastDriveVersion &&
      metadata.version === linkedFile.entry.lastDriveVersion &&
      !needsAssetMigration &&
      !trackedAssetsNeedRepair
    ) {
      return {
        status: "skipped",
        message: "Remote version unchanged."
      };
    }

    const localState = await this.readLocalFileState(baseTargetPath, localText);
    if (needsOverwriteConfirmation(localState, linkedFile.entry.lastLocalHash) && !options.force) {
      return {
        status: "cancelled",
        message: `Local changes detected in ${path.basename(baseTargetPath)}. Re-run with --force to overwrite.`
      };
    }

    const preparedContent =
      linkedFile.entry.lastDriveVersion &&
      metadata.version === linkedFile.entry.lastDriveVersion &&
      localText &&
      needsAssetMigration &&
      !trackedAssetsNeedRepair
        ? extractMarkdownAssets(baseTargetPath, localText)
        : await this.prepareMarkdownOutput(
            baseTargetPath,
            accessToken,
            linkedFile.entry.fileId,
            linkedFile.entry.resourceKey,
            profile,
            metadata.name
          );
    await this.syncGeneratedFiles(baseTargetPath, this.getTrackedGeneratedFilePaths(linkedFile.entry), preparedContent.assets);
    await this.writeTextFile(baseTargetPath, preparedContent.markdown);
    const nextHash = sha256Text(preparedContent.markdown);
    await this.manifestStore.updateLinkedFile(baseTargetPath, (entry) => ({
      ...entry,
      outputKind: "file",
      title: metadata.name,
      sourceUrl: metadata.webViewLink || profile.buildSourceUrl(metadata.id),
      sourceMimeType: metadata.mimeType,
      resourceKey: metadata.resourceKey || entry.resourceKey,
      generatedFiles: preparedContent.assets.map((asset) => ({
        relativePath: asset.relativePath,
        contentHash: asset.contentHash
      })),
      generatedFilePaths: preparedContent.generatedAssetPaths,
      lastDriveVersion: metadata.version,
      lastLocalHash: nextHash,
      lastSyncedAt: new Date().toISOString()
    }));

    return {
      status: "synced",
      message: `Synced ${path.basename(baseTargetPath)}.`
    };
  }

  private async doSpreadsheetSync(
    baseTargetPath: string,
    linkedFile: LinkedFileContext,
    profile: ReturnType<typeof getSyncProfile>,
    metadata: { id: string; name: string; mimeType: string; version: string; resourceKey?: string; webViewLink?: string },
    accessToken: string,
    options: CliSyncOptions
  ): Promise<SyncOutcome> {
    const outputState = await this.inspectSpreadsheetOutputState(baseTargetPath, linkedFile.entry);
    if (
      linkedFile.entry.lastDriveVersion &&
      metadata.version === linkedFile.entry.lastDriveVersion &&
      !outputState.hasMissing &&
      !outputState.hasModified
    ) {
      return {
        status: "skipped",
        message: "Remote version unchanged."
      };
    }

    if (outputState.hasModified && !options.force) {
      return {
        status: "cancelled",
        message: `Local CSV changes detected in ${path.basename(baseTargetPath)}. Re-run with --force to overwrite.`
      };
    }

    const workbookBytes = await this.fetchWorkbookBytes(accessToken, linkedFile.entry.fileId, linkedFile.entry.resourceKey, profile);
    const workbookOutput = parseWorkbookToCsvOutput(baseTargetPath, workbookBytes);
    const syncSummary = buildSpreadsheetSyncSummary({
      baseTargetPath,
      previousOutputKind: linkedFile.entry.outputKind,
      nextOutputKind: workbookOutput.outputKind,
      visibleSheetCount: workbookOutput.visibleSheetCount
    });

    if (workbookOutput.outputKind === "file" && workbookOutput.primaryFileText === undefined) {
      throw new Error("Spreadsheet sync did not produce a primary CSV file.");
    }

    if (workbookOutput.outputKind === "directory") {
      await this.syncGeneratedFiles(baseTargetPath, this.getTrackedGeneratedFilePaths(linkedFile.entry), workbookOutput.generatedFiles);
      if (linkedFile.entry.outputKind === "file") {
        await this.deletePrimaryFile(baseTargetPath);
      }
    } else {
      await this.writeTextFile(baseTargetPath, workbookOutput.primaryFileText || "");
      await this.syncGeneratedFiles(baseTargetPath, this.getTrackedGeneratedFilePaths(linkedFile.entry), []);
    }

    const nextHash = workbookOutput.outputKind === "file" ? sha256Text(workbookOutput.primaryFileText || "") : undefined;
    await this.manifestStore.updateLinkedFile(baseTargetPath, (entry) => ({
      ...entry,
      outputKind: workbookOutput.outputKind,
      title: metadata.name,
      sourceUrl: metadata.webViewLink || profile.buildSourceUrl(metadata.id),
      sourceMimeType: metadata.mimeType,
      resourceKey: metadata.resourceKey || entry.resourceKey,
      generatedFiles:
        workbookOutput.outputKind === "directory"
          ? workbookOutput.generatedFiles.map((generatedFile) => ({
              relativePath: generatedFile.relativePath,
              contentHash: generatedFile.contentHash
            }))
          : undefined,
      generatedFilePaths:
        workbookOutput.outputKind === "directory"
          ? workbookOutput.generatedFiles.map((generatedFile) => generatedFile.relativePath)
          : undefined,
      lastDriveVersion: metadata.version,
      lastLocalHash: nextHash,
      lastSyncedAt: new Date().toISOString()
    }));

    return {
      status: "synced",
      message: syncSummary,
      transition:
        linkedFile.entry.outputKind !== workbookOutput.outputKind
          ? {
              kind: "spreadsheet-output-kind-changed",
              previousOutputKind: linkedFile.entry.outputKind,
              nextOutputKind: workbookOutput.outputKind,
              generatedDirectoryPath:
                workbookOutput.outputKind === "directory"
                  ? path.join(path.dirname(baseTargetPath), path.parse(baseTargetPath).name)
                  : undefined
            }
          : undefined
    };
  }

  private async fetchSourceMarkdown(
    accessToken: string,
    fileId: string,
    resourceKey: string | undefined,
    profile: ReturnType<typeof getSyncProfile>
  ): Promise<string> {
    if (profile.retrievalMode === "drive-download-docx") {
      const docxBytes = await this.driveClient.downloadFile(accessToken, fileId, resourceKey);
      return convertDocxToMarkdown(docxBytes);
    }

    return this.driveClient.exportText(accessToken, fileId, profile.exportMimeType, resourceKey);
  }

  private async prepareMarkdownOutput(
    markdownFilePath: string,
    accessToken: string,
    fileId: string,
    resourceKey: string | undefined,
    profile: ReturnType<typeof getSyncProfile>,
    title: string
  ) {
    if (profile.localFormat === "marp") {
      const presentationBytes = await this.fetchPresentationBytes(accessToken, fileId, resourceKey, profile);
      return convertPresentationToMarp(markdownFilePath, presentationBytes, {
        assetMode: "external",
        title
      });
    }

    const sourceText = await this.fetchSourceMarkdown(accessToken, fileId, resourceKey, profile);
    return extractMarkdownAssets(markdownFilePath, sourceText);
  }

  private async fetchPresentationBytes(
    accessToken: string,
    fileId: string,
    resourceKey: string | undefined,
    profile: ReturnType<typeof getSyncProfile>
  ): Promise<Uint8Array> {
    if (profile.retrievalMode === "drive-export-pptx") {
      return this.driveClient.exportFile(accessToken, fileId, profile.exportMimeType, resourceKey);
    }

    return this.driveClient.downloadFile(accessToken, fileId, resourceKey);
  }

  private async fetchWorkbookBytes(
    accessToken: string,
    fileId: string,
    resourceKey: string | undefined,
    profile: ReturnType<typeof getSyncProfile>
  ): Promise<Uint8Array> {
    if (profile.retrievalMode === "drive-export-xlsx") {
      return this.driveClient.exportFile(accessToken, fileId, profile.exportMimeType, resourceKey);
    }

    return this.driveClient.downloadFile(accessToken, fileId, resourceKey);
  }

  private getBaseTargetPath(linkedFile: LinkedFileContext): string {
    return fromManifestKey(linkedFile.folderPath, linkedFile.key);
  }

  private getTrackedGeneratedFiles(entry: LinkedFileEntry): GeneratedFileRecord[] {
    if (entry.generatedFiles && entry.generatedFiles.length > 0) {
      return entry.generatedFiles;
    }

    return (entry.generatedFilePaths || []).map((relativePath) => ({ relativePath }));
  }

  private getTrackedGeneratedFilePaths(entry: LinkedFileEntry): string[] | undefined {
    const trackedGeneratedFiles = this.getTrackedGeneratedFiles(entry);
    return trackedGeneratedFiles.length > 0 ? trackedGeneratedFiles.map((generatedFile) => generatedFile.relativePath) : undefined;
  }

  private async inspectSpreadsheetOutputState(baseTargetPath: string, entry: LinkedFileEntry): Promise<TrackedOutputState> {
    if (entry.outputKind === "directory") {
      return this.inspectTrackedGeneratedFiles(baseTargetPath, entry);
    }

    const localText = await this.readLocalFileText(baseTargetPath);
    const localState = await this.readLocalFileState(baseTargetPath, localText);
    return {
      hasMissing: !localState.fileExists,
      hasModified: needsOverwriteConfirmation(localState, entry.lastLocalHash)
    };
  }

  private async inspectTrackedGeneratedFiles(baseTargetPath: string, entry: LinkedFileEntry): Promise<TrackedOutputState> {
    const trackedGeneratedFiles = this.getTrackedGeneratedFiles(entry);
    if (trackedGeneratedFiles.length === 0) {
      return { hasMissing: false, hasModified: false };
    }

    let hasMissing = false;
    let hasModified = false;
    const fileDirectory = path.dirname(baseTargetPath);
    for (const generatedFile of trackedGeneratedFiles) {
      const absolutePath = path.join(fileDirectory, ...generatedFile.relativePath.split("/"));

      let fileBytes: Uint8Array;
      try {
        fileBytes = await readFile(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          hasMissing = true;
          continue;
        }

        throw error;
      }

      if (!generatedFile.contentHash) {
        hasMissing = true;
        continue;
      }

      if (sha256Bytes(fileBytes) !== generatedFile.contentHash) {
        hasModified = true;
      }
    }

    return { hasMissing, hasModified };
  }

  private async syncGeneratedFiles(
    filePath: string,
    previousGeneratedPaths: string[] | undefined,
    nextFiles: GeneratedFilePayload[]
  ): Promise<void> {
    const fileDirectory = path.dirname(filePath);
    const nextPaths = new Set(nextFiles.map((generatedFile) => generatedFile.relativePath));

    for (const generatedFile of nextFiles) {
      const absolutePath = path.join(fileDirectory, ...generatedFile.relativePath.split("/"));
      await mkdir(path.dirname(absolutePath), { recursive: true });
      if (generatedFile.mimeType === "text/csv") {
        await this.writeTextFile(absolutePath, Buffer.from(generatedFile.bytes).toString("utf8"));
      } else {
        await writeFile(absolutePath, generatedFile.bytes);
      }
    }

    for (const previousGeneratedPath of previousGeneratedPaths || []) {
      if (nextPaths.has(previousGeneratedPath)) {
        continue;
      }

      const absolutePath = path.join(fileDirectory, ...previousGeneratedPath.split("/"));
      try {
        await unlink(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }

    const directories = new Set<string>();
    for (const previousGeneratedPath of previousGeneratedPaths || []) {
      directories.add(path.dirname(previousGeneratedPath));
    }
    for (const generatedFile of nextFiles) {
      directories.add(path.dirname(generatedFile.relativePath));
    }

    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      const absoluteDirectory = path.join(fileDirectory, ...directory.split("/"));
      try {
        await rmdir(absoluteDirectory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTEMPTY") {
          throw error;
        }
      }
    }
  }

  private async deletePrimaryFile(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async writeTextFile(filePath: string, text: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, text, "utf8");
  }

  private async readLocalFileText(filePath: string): Promise<string | undefined> {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  private async readLocalFileState(filePath: string, existingText?: string): Promise<LocalFileState> {
    if (existingText !== undefined) {
      return {
        fileExists: true,
        isDirty: false,
        currentHash: sha256Text(existingText)
      };
    }

    try {
      const rawValue = await readFile(filePath, "utf8");
      return {
        fileExists: true,
        isDirty: false,
        currentHash: sha256Text(rawValue)
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          fileExists: false,
          isDirty: false
        };
      }

      throw error;
    }
  }

  private slugifyTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "google-file";
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
