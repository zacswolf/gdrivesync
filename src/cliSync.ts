import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { CliManifestStore } from "./cliManifestStore";
import { convertDocxToMarkdown } from "./docxConverter";
import { DriveClient, GoogleApiError, PickerGrantRequiredError } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { LocalFileState, needsOverwriteConfirmation } from "./overwritePolicy";
import { convertPresentationToMarp } from "./presentationConverter";
import { convertSlidesApiPresentationToMarp } from "./slidesApiPresentationConverter";
import { SlidesClient } from "./slidesClient";
import { getSyncProfile, getSyncProfilesForTargetFamily, resolveSyncProfileForMimeType } from "./syncProfiles";
import { ImageEnrichmentService, ImageEnrichmentSettings } from "./imageEnrichment";
import {
  ConnectedGoogleAccount,
  GeneratedFilePayload,
  GeneratedFileRecord,
  LinkedFileContext,
  LinkedFileEntry,
  PickerSelection,
  SyncOutcome,
  SyncOutputKind
} from "./types";
import { sha256Bytes, sha256Text } from "./utils/hash";
import { extractGoogleResourceKey } from "./utils/docUrl";
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
  accountId?: string;
  imageEnrichmentSettings?: ImageEnrichmentSettings;
  progress?: (message: string) => void;
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

interface CliExportOptions {
  targetPath?: string;
  includePresentationBackgrounds?: boolean;
  imageEnrichmentSettings?: ImageEnrichmentSettings;
  progress?: (message: string) => void;
}

export class CliSyncManager {
  constructor(
    private readonly authManager: GoogleAuthManager,
    private readonly driveClient: DriveClient,
    private readonly manifestStore: CliManifestStore,
    private readonly slidesClient: SlidesClient,
    private readonly imageEnrichmentService: ImageEnrichmentService
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

  async resolveSelectionFromInput(rawInput: string, targetPath: string, accountId?: string): Promise<PickerSelection> {
    const { parseGoogleDocInput } = await import("./utils/docUrl");
    const parsedInput = parseGoogleDocInput(rawInput);
    if (!parsedInput) {
      throw new Error("Pass a Google Docs, Slides, Sheets, Drive, DOCX, PPTX, or XLSX file URL or raw file ID.");
    }

    const allowedProfiles = this.getAllowedProfilesForTargetPath(targetPath);
    const parsedResourceKey = parsedInput.resourceKey || extractGoogleResourceKey(parsedInput.sourceUrl);
    const { account, metadata } = await this.resolveSelectionMetadata(
      parsedInput.fileId,
      parsedResourceKey,
      allowedProfiles.map((profile) => profile.sourceMimeType),
      "supported Google file",
      accountId
    );
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
      resourceKey: metadata.resourceKey || parsedResourceKey,
      accountId: account.accountId,
      accountEmail: account.accountEmail,
      accountDisplayName: account.accountDisplayName
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
      accountId: selection.accountId,
      accountEmail: selection.accountEmail,
      generatedFiles: undefined,
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
        const scopedOptions =
          options.progress
            ? {
                ...options,
                progress: (message: string) => options.progress?.(`${results.length + 1}/${linkedFiles.length}: ${path.basename(linkedFile.filePath)} — ${message}`)
              }
            : options;
        outcome = await this.syncFile(linkedFile.filePath, scopedOptions);
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

  async exportSelection(selection: PickerSelection, options: CliExportOptions = {}): Promise<CliExportResult> {
    const profile = getSyncProfile(selection.profileId);
    const { accessToken } = await this.authManager.getAccessToken(selection.accountId);
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
        ? await this.preparePresentationOutput(
            exportMarkdownPath,
            accessToken,
            selection.fileId,
            selection.resourceKey,
            profile,
            metadata.name || selection.title,
            options.targetPath ? "external" : "data-uri",
            options.includePresentationBackgrounds ?? false
          )
        : extractMarkdownAssets(
            exportMarkdownPath,
            await this.fetchSourceMarkdown(accessToken, selection.fileId, selection.resourceKey, profile)
          );
    const enrichedMarkdownResult = await this.maybeApplyImageEnrichment(
      markdownResult,
      options.imageEnrichmentSettings,
      options.progress
    );
    if (!options?.targetPath) {
      return {
        outputKind: "file",
        message: `Exported ${metadata.name} to stdout.`,
        primaryText: enrichedMarkdownResult.markdown,
        writtenPaths: []
      };
    }

    const targetPath = options.targetPath;
    await this.syncGeneratedFiles(targetPath, undefined, enrichedMarkdownResult.assets);
    await this.writeTextFile(targetPath, enrichedMarkdownResult.markdown);
    return {
        targetPath,
        outputKind: "file",
        message: this.buildExportMessage(`Exported ${metadata.name} to ${path.basename(targetPath)}.`, enrichedMarkdownResult.stats),
        primaryText: enrichedMarkdownResult.markdown,
        writtenPaths: [
        targetPath,
        ...enrichedMarkdownResult.assets.map((asset) => path.join(path.dirname(targetPath), ...asset.relativePath.split("/")))
      ]
    };
  }

  private async doSyncFile(linkedFile: LinkedFileContext, options: CliSyncOptions): Promise<SyncOutcome> {
    const profile = getSyncProfile(linkedFile.entry.profileId);
    const baseTargetPath = this.getBaseTargetPath(linkedFile);
    const access = await this.resolveLinkedFileAccess(linkedFile, profile, options.accountId);
    const { accessToken, metadata, account, rebound } = access;

    if (profile.targetFamily === "csv") {
      return this.doSpreadsheetSync(baseTargetPath, linkedFile, profile, metadata, accessToken, account, rebound, options);
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
      const localEnrichmentOutcome = await this.maybeRefreshImageEnrichment(
        baseTargetPath,
        linkedFile,
        profile,
        metadata,
        account,
        rebound,
        localText,
        options
      );
      if (localEnrichmentOutcome) {
        return localEnrichmentOutcome;
      }

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
    const enrichedContent = await this.maybeApplyImageEnrichment(
      preparedContent,
      options.imageEnrichmentSettings,
      options.progress
    );
    await this.syncGeneratedFiles(baseTargetPath, this.getTrackedGeneratedFilePaths(linkedFile.entry), enrichedContent.assets);
    await this.writeTextFile(baseTargetPath, enrichedContent.markdown);
    const nextHash = sha256Text(enrichedContent.markdown);
    await this.manifestStore.updateLinkedFile(baseTargetPath, (entry) => ({
      ...entry,
      outputKind: "file",
      accountId: account.accountId,
      accountEmail: account.accountEmail,
      title: metadata.name,
      sourceUrl: metadata.webViewLink || profile.buildSourceUrl(metadata.id),
      sourceMimeType: metadata.mimeType,
      resourceKey: metadata.resourceKey || entry.resourceKey,
      generatedFiles: enrichedContent.assets.map((asset) => ({
        relativePath: asset.relativePath,
        contentHash: asset.contentHash
      })),
      lastDriveVersion: metadata.version,
      lastLocalHash: nextHash,
      lastSyncedAt: new Date().toISOString()
    }));

    return {
      status: "synced",
      message: rebound
        ? `${this.buildMarkdownSyncMessage(path.basename(baseTargetPath), enrichedContent.stats)} Rebound it to ${account.accountEmail || account.accountId}.`
        : this.buildMarkdownSyncMessage(path.basename(baseTargetPath), enrichedContent.stats),
      rebind: rebound
    };
  }

  private async maybeApplyImageEnrichment(
    preparedContent: { markdown: string; assets: GeneratedFilePayload[] },
    imageEnrichmentSettings: ImageEnrichmentSettings | undefined,
    progress?: (message: string) => void
  ): Promise<{
    markdown: string;
    assets: GeneratedFilePayload[];
    stats?: {
      enrichedImageCount: number;
      providerLabel?: string;
      failureMessages?: string[];
    };
  }> {
    if (!imageEnrichmentSettings || imageEnrichmentSettings.mode === "off" || imageEnrichmentSettings.mode === "prompt") {
      return {
        ...preparedContent
      };
    }

    const enrichedResult = await this.imageEnrichmentService.enrichMarkdown(
      preparedContent.markdown,
      preparedContent.assets,
      imageEnrichmentSettings,
      progress
        ? {
            report(message: string) {
              progress(message);
            }
          }
        : undefined
    );
    progress?.(
      `Image enrichment completed: mode=${imageEnrichmentSettings.mode}, eligible=${enrichedResult.stats.eligibleImageCount}, genericEligible=${enrichedResult.stats.genericCandidateCount}, upgradeEligible=${enrichedResult.stats.upgradeCandidateCount}, enriched=${enrichedResult.stats.enrichedImageCount}, cacheHits=${enrichedResult.stats.cacheHitCount}, skipped=${enrichedResult.stats.skippedImageCount}.`
    );
    for (const failureMessage of enrichedResult.stats.failureMessages) {
      progress?.(`Image enrichment warning: ${failureMessage}`);
    }
    return {
      markdown: enrichedResult.markdown,
      assets: preparedContent.assets,
      stats: {
        enrichedImageCount: enrichedResult.stats.enrichedImageCount,
        providerLabel: enrichedResult.stats.providerLabel,
        failureMessages: enrichedResult.stats.failureMessages
      }
    };
  }

  private buildMarkdownSyncMessage(
    fileName: string,
    enrichmentStats?: { enrichedImageCount: number; providerLabel?: string; failureMessages?: string[] }
  ): string {
    const warningLabel =
      enrichmentStats?.failureMessages && enrichmentStats.failureMessages.length > 0
        ? " Some images could not be enriched."
        : "";

    if (!enrichmentStats?.enrichedImageCount) {
      return `Synced ${fileName}.${warningLabel}`;
    }

    const providerLabel = enrichmentStats.providerLabel ? ` using ${enrichmentStats.providerLabel}` : "";
    return `Synced ${fileName} and enriched ${enrichmentStats.enrichedImageCount} image${enrichmentStats.enrichedImageCount === 1 ? "" : "s"}${providerLabel}.${warningLabel}`;
  }

  private buildExportMessage(
    baseMessage: string,
    enrichmentStats?: { enrichedImageCount: number; providerLabel?: string; failureMessages?: string[] }
  ): string {
    const warningLabel =
      enrichmentStats?.failureMessages && enrichmentStats.failureMessages.length > 0
        ? " Some images could not be enriched."
        : "";

    if (!enrichmentStats?.enrichedImageCount) {
      return `${baseMessage}${warningLabel}`;
    }

    const providerLabel = enrichmentStats.providerLabel ? ` using ${enrichmentStats.providerLabel}` : "";
    return `${baseMessage} Enriched ${enrichmentStats.enrichedImageCount} image${enrichmentStats.enrichedImageCount === 1 ? "" : "s"}${providerLabel}.${warningLabel}`;
  }

  private async maybeRefreshImageEnrichment(
    baseTargetPath: string,
    linkedFile: LinkedFileContext,
    profile: ReturnType<typeof getSyncProfile>,
    metadata: { id: string; name: string; mimeType: string; version: string; resourceKey?: string; webViewLink?: string },
    account: ConnectedGoogleAccount,
    rebound: SyncOutcome["rebind"] | undefined,
    localText: string | undefined,
    options: CliSyncOptions
  ): Promise<SyncOutcome | undefined> {
    if (!localText || !options.imageEnrichmentSettings || options.imageEnrichmentSettings.mode === "off") {
      return undefined;
    }

    const localAssets = await this.readTrackedGeneratedFilePayloads(baseTargetPath, linkedFile.entry);
    if (localAssets.length === 0) {
      return undefined;
    }

    const localState = await this.readLocalFileState(baseTargetPath, localText);
    if (needsOverwriteConfirmation(localState, linkedFile.entry.lastLocalHash) && !options.force) {
      return undefined;
    }

    const enrichedContent = await this.maybeApplyImageEnrichment(
      {
        markdown: localText,
        assets: localAssets
      },
      options.imageEnrichmentSettings,
      options.progress
    );
    if (enrichedContent.markdown === localText) {
      return undefined;
    }

    await this.writeTextFile(baseTargetPath, enrichedContent.markdown);
    const nextHash = sha256Text(enrichedContent.markdown);
    await this.manifestStore.updateLinkedFile(baseTargetPath, (entry) => ({
      ...entry,
      outputKind: "file",
      accountId: account.accountId,
      accountEmail: account.accountEmail,
      title: metadata.name,
      sourceUrl: metadata.webViewLink || profile.buildSourceUrl(metadata.id),
      sourceMimeType: metadata.mimeType,
      resourceKey: metadata.resourceKey || entry.resourceKey,
      lastDriveVersion: metadata.version,
      lastLocalHash: nextHash,
      lastSyncedAt: new Date().toISOString()
    }));

    options.progress?.(`Applied image enrichment refresh to ${path.basename(baseTargetPath)} without downloading new Google content.`);
    return {
      status: "synced",
      message: rebound
        ? `${this.buildMarkdownSyncMessage(path.basename(baseTargetPath), enrichedContent.stats)} Rebound it to ${account.accountEmail || account.accountId}.`
        : this.buildMarkdownSyncMessage(path.basename(baseTargetPath), enrichedContent.stats),
      rebind: rebound
    };
  }

  private async doSpreadsheetSync(
    baseTargetPath: string,
    linkedFile: LinkedFileContext,
    profile: ReturnType<typeof getSyncProfile>,
    metadata: { id: string; name: string; mimeType: string; version: string; resourceKey?: string; webViewLink?: string },
    accessToken: string,
    account: ConnectedGoogleAccount,
    rebound: SyncOutcome["rebind"] | undefined,
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
      accountId: account.accountId,
      accountEmail: account.accountEmail,
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
      lastDriveVersion: metadata.version,
      lastLocalHash: nextHash,
      lastSyncedAt: new Date().toISOString()
    }));

    return {
      status: "synced",
      message: rebound
        ? `${syncSummary} Rebound it to ${account.accountEmail || account.accountId}.`
        : syncSummary,
      rebind: rebound,
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
    if (profile.retrievalMode === "drive-download-docx" || profile.retrievalMode === "drive-export-docx") {
      try {
        const docxBytes =
          profile.retrievalMode === "drive-export-docx"
            ? await this.driveClient.exportFile(accessToken, fileId, profile.exportMimeType, resourceKey)
            : await this.driveClient.downloadFile(accessToken, fileId, resourceKey);
        return convertDocxToMarkdown(docxBytes);
      } catch (error) {
        if (profile.retrievalMode === "drive-export-docx" && error instanceof GoogleApiError && error.reason === "exportSizeLimitExceeded") {
          return this.driveClient.exportText(accessToken, fileId, "text/markdown", resourceKey);
        }

        throw error;
      }
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
      return this.preparePresentationOutput(markdownFilePath, accessToken, fileId, resourceKey, profile, title, "external", false);
    }

    const sourceText = await this.fetchSourceMarkdown(accessToken, fileId, resourceKey, profile);
    return extractMarkdownAssets(markdownFilePath, sourceText);
  }

  private async preparePresentationOutput(
    markdownFilePath: string,
    accessToken: string,
    fileId: string,
    resourceKey: string | undefined,
    profile: ReturnType<typeof getSyncProfile>,
    title: string,
    assetMode: "external" | "data-uri",
    includeBackgrounds: boolean
  ) {
    try {
      const presentationBytes = await this.fetchPresentationBytes(accessToken, fileId, resourceKey, profile);
      return await convertPresentationToMarp(markdownFilePath, presentationBytes, {
        assetMode,
        title
      });
    } catch (error) {
      if (profile.id === "google-slide-marp" && error instanceof GoogleApiError && error.reason === "exportSizeLimitExceeded") {
        const presentation = await this.slidesClient.getPresentation(accessToken, fileId);
        return convertSlidesApiPresentationToMarp(
          markdownFilePath,
          presentation,
          {
            assetMode,
            title,
            includeBackgrounds
          }
        );
      }

      throw error;
    }
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
    return entry.generatedFiles || [];
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

  private async readTrackedGeneratedFilePayloads(
    baseTargetPath: string,
    entry: LinkedFileEntry
  ): Promise<GeneratedFilePayload[]> {
    const trackedGeneratedFiles = this.getTrackedGeneratedFiles(entry);
    const payloads: GeneratedFilePayload[] = [];
    const fileDirectory = path.dirname(baseTargetPath);
    for (const generatedFile of trackedGeneratedFiles) {
      const absolutePath = path.join(fileDirectory, ...generatedFile.relativePath.split("/"));
      const fileBytes = await readFile(absolutePath);
      const mimeType = this.mimeTypeFromGeneratedPath(generatedFile.relativePath);
      if (!mimeType) {
        continue;
      }
      payloads.push({
        relativePath: generatedFile.relativePath,
        bytes: fileBytes,
        mimeType,
        contentHash: generatedFile.contentHash || sha256Bytes(fileBytes)
      });
    }

    return payloads;
  }

  private mimeTypeFromGeneratedPath(relativePath: string): string | undefined {
    const extension = path.extname(relativePath).toLowerCase();
    if (extension === ".png") {
      return "image/png";
    }
    if (extension === ".jpg" || extension === ".jpeg") {
      return "image/jpeg";
    }
    if (extension === ".gif") {
      return "image/gif";
    }
    if (extension === ".webp") {
      return "image/webp";
    }
    if (extension === ".bmp") {
      return "image/bmp";
    }
    if (extension === ".tif" || extension === ".tiff") {
      return "image/tiff";
    }

    return undefined;
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

  private shouldTryAnotherAccount(error: unknown): boolean {
    if (error instanceof PickerGrantRequiredError) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes("cannot be refreshed") ||
      message.includes("No connected Google account matches") ||
      message.includes("cannot access file") ||
      message.includes("cannot access Google file") ||
      message.includes("missing the required Drive read-only scope")
    );
  }

  private async getCandidateAccounts(preferredAccountId?: string, explicitAccountId?: string): Promise<ConnectedGoogleAccount[]> {
    if (explicitAccountId) {
      return [await this.authManager.resolveAccount(explicitAccountId)];
    }

    return this.authManager.getAccountsInPriorityOrder(preferredAccountId);
  }

  private async resolveSelectionMetadata(
    fileId: string,
    resourceKey: string | undefined,
    expectedMimeTypes: string[],
    sourceTypeLabel: string,
    explicitAccountId?: string
  ): Promise<{ account: ConnectedGoogleAccount; metadata: Awaited<ReturnType<DriveClient["getFileMetadata"]>> }> {
    const candidates = await this.getCandidateAccounts(undefined, explicitAccountId);
    let lastError: unknown;

    for (const account of candidates) {
      try {
        const { accessToken } = await this.authManager.getAccessToken(account.accountId);
        const metadata = await this.driveClient.getFileMetadata(accessToken, {
          fileId,
          resourceKey,
          expectedMimeTypes,
          sourceTypeLabel
        });
        return { account, metadata };
      } catch (error) {
        lastError = error;
        if (!this.shouldTryAnotherAccount(error) || explicitAccountId) {
          throw error;
        }
      }
    }

    throw lastError || new Error("No connected Google account can access that file.");
  }

  private async resolveLinkedFileAccess(
    linkedFile: LinkedFileContext,
    profile: ReturnType<typeof getSyncProfile>,
    explicitAccountId?: string
  ): Promise<{
    account: ConnectedGoogleAccount;
    accessToken: string;
    metadata: Awaited<ReturnType<DriveClient["getFileMetadata"]>>;
    rebound?: SyncOutcome["rebind"];
  }> {
    const preferredAccountId = explicitAccountId || linkedFile.entry.accountId;
    const candidates = await this.getCandidateAccounts(preferredAccountId, explicitAccountId);
    let lastError: unknown;

    for (const account of candidates) {
      try {
        const { accessToken } = await this.authManager.getAccessToken(account.accountId);
        const metadata = await this.driveClient.getFileMetadata(accessToken, {
          fileId: linkedFile.entry.fileId,
          resourceKey: linkedFile.entry.resourceKey,
          expectedMimeTypes: [linkedFile.entry.sourceMimeType],
          sourceTypeLabel: profile.sourceTypeLabel
        });
        const rebound =
          linkedFile.entry.accountId && linkedFile.entry.accountId !== account.accountId
            ? {
                previousAccountId: linkedFile.entry.accountId,
                previousAccountEmail: linkedFile.entry.accountEmail,
                nextAccountId: account.accountId,
                nextAccountEmail: account.accountEmail
              }
            : undefined;
        return {
          account,
          accessToken,
          metadata,
          rebound
        };
      } catch (error) {
        lastError = error;
        if (!this.shouldTryAnotherAccount(error) || explicitAccountId) {
          throw error;
        }
      }
    }

    throw lastError || new Error("No connected Google account can access the linked file.");
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
