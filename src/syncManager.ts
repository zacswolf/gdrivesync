import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import * as vscode from "vscode";

import { convertDocxToMarkdown } from "./docxConverter";
import { DriveClient, GoogleApiError, PickerGrantRequiredError } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { ManifestStore } from "./manifestStore";
import { LocalFileState, needsOverwriteConfirmation } from "./overwritePolicy";
import { convertPresentationToMarp } from "./presentationConverter";
import { convertSlidesApiPresentationToMarp } from "./slidesApiPresentationConverter";
import { SlidesClient } from "./slidesClient";
import { getSyncProfile, SyncProfile } from "./syncProfiles";
import {
  ConnectedGoogleAccount,
  GeneratedFilePayload,
  GeneratedFileRecord,
  LinkedFileContext,
  LinkedFileEntry,
  PickerSelection,
  SyncOutcome
} from "./types";
import { sha256Bytes, sha256Text } from "./utils/hash";
import { fromManifestKey } from "./utils/paths";
import { containsEmbeddedImageData, extractMarkdownAssets } from "./utils/markdownAssets";
import { buildSpreadsheetSyncSummary } from "./utils/spreadsheetSyncSummary";
import { parseWorkbookToCsvOutput } from "./workbookCsv";

interface TrackedOutputState {
  hasMissing: boolean;
  hasModified: boolean;
}

export interface SyncProgressReporter {
  report(message: string): void;
}

interface SyncFileOptions {
  reason?: "manual" | "open" | "link";
  progress?: SyncProgressReporter;
}

export class SyncManager {
  private readonly inFlightSyncs = new Map<string, Promise<SyncOutcome>>();
  private readonly openDebounce = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly authManager: GoogleAuthManager,
    private readonly driveClient: DriveClient,
    private readonly manifestStore: ManifestStore,
    private readonly slidesClient: SlidesClient
  ) {}

  async linkFile(fileUri: vscode.Uri, selection: PickerSelection, options?: { progress?: SyncProgressReporter }): Promise<SyncOutcome> {
    const syncOnOpen = vscode.workspace.getConfiguration("gdocSync").get<boolean>("syncOnOpenDefault", false);
    const profile = getSyncProfile(selection.profileId);
    await this.manifestStore.linkFile(fileUri, {
      profileId: selection.profileId,
      fileId: selection.fileId,
      sourceUrl: selection.sourceUrl,
      sourceMimeType: selection.sourceMimeType || profile.sourceMimeType,
      exportMimeType: profile.exportMimeType,
      localFormat: profile.localFormat,
      outputKind: "file",
      resourceKey: selection.resourceKey,
      title: selection.title,
      syncOnOpen,
      accountId: selection.accountId,
      accountEmail: selection.accountEmail,
      generatedFiles: undefined,
      lastDriveVersion: undefined,
      lastLocalHash: undefined,
      lastSyncedAt: undefined
    });
    try {
      return await this.syncFile(fileUri, { reason: "link", progress: options?.progress });
    } catch (error) {
      await this.manifestStore.unlinkFile(fileUri);
      throw error;
    }
  }

  async toggleSyncOnOpen(fileUri: vscode.Uri): Promise<boolean> {
    const context = await this.manifestStore.updateLinkedFile(fileUri, (entry) => ({
      ...entry,
      syncOnOpen: !entry.syncOnOpen
    }));
    return context.entry.syncOnOpen;
  }

  async unlinkFile(fileUri: vscode.Uri, options?: { removeGeneratedFiles?: boolean }): Promise<boolean> {
    const context = await this.manifestStore.getLinkedFile(fileUri);
    if (!context) {
      return false;
    }

    const baseTargetUri = this.getBaseTargetUri(context);
    if (options?.removeGeneratedFiles) {
      await this.syncGeneratedFiles(baseTargetUri, this.getTrackedGeneratedFilePaths(context.entry), []);
      if (context.entry.outputKind === "file" && context.matchedOutputKind === "primary") {
        await this.deletePrimaryFile(baseTargetUri);
      }
    }

    return this.manifestStore.unlinkFile(fileUri);
  }

  async syncFile(fileUri: vscode.Uri, options?: SyncFileOptions): Promise<SyncOutcome> {
    const linkedFile = await this.manifestStore.getLinkedFile(fileUri);
    if (!linkedFile) {
      throw new Error("This file is not linked to a Google source yet.");
    }

    const syncKey = `${linkedFile.folderPath}:${linkedFile.key}`;
    const activeSync = this.inFlightSyncs.get(syncKey);
    if (activeSync) {
      return activeSync;
    }

    const syncTask = this.doSyncFile(linkedFile, options).finally(() => {
      this.inFlightSyncs.delete(syncKey);
    });
    this.inFlightSyncs.set(syncKey, syncTask);
    return syncTask;
  }

  async syncAll(options?: { progress?: SyncProgressReporter }): Promise<{
    results: Array<{ file: string; outcome: SyncOutcome }>;
    syncedCount: number;
    skippedCount: number;
    cancelledCount: number;
  }> {
    const linkedFiles = await this.manifestStore.listLinkedFiles();
    const results: Array<{ file: string; outcome: SyncOutcome }> = [];
    let syncedCount = 0;
    let skippedCount = 0;
    let cancelledCount = 0;
    for (const [index, linkedFile] of linkedFiles.entries()) {
      const baseTargetUri = this.getBaseTargetUri(linkedFile.context);
      const scopedProgress = options?.progress
        ? {
            report: (message: string) =>
              options.progress?.report(`${index + 1}/${linkedFiles.length}: ${path.basename(baseTargetUri.fsPath)} — ${message}`)
          }
        : undefined;
      const outcome = await this.syncFile(linkedFile.fileUri, { reason: "manual", progress: scopedProgress });
      if (outcome.status === "synced") {
        syncedCount += 1;
      } else if (outcome.status === "skipped") {
        skippedCount += 1;
      } else if (outcome.status === "cancelled") {
        cancelledCount += 1;
      }

      results.push({
        file: linkedFile.fileUri.fsPath,
        outcome
      });
    }

    return { results, syncedCount, skippedCount, cancelledCount };
  }

  scheduleSyncOnOpen(fileUri: vscode.Uri): void {
    const key = fileUri.toString();
    const existingHandle = this.openDebounce.get(key);
    if (existingHandle) {
      clearTimeout(existingHandle);
    }

    const handle = setTimeout(async () => {
      this.openDebounce.delete(key);
      const context = await this.manifestStore.getLinkedFile(fileUri);
      if (!context?.entry.syncOnOpen) {
        return;
      }

      try {
        const outcome = await this.syncFile(fileUri, { reason: "open" });
        if (outcome.status === "synced") {
          void vscode.window.setStatusBarMessage(`Synced ${path.basename(fileUri.fsPath)} from Google`, 3500);
        }
      } catch (error) {
        void vscode.window.showErrorMessage(this.toErrorMessage(error));
      }
    }, 600);

    this.openDebounce.set(key, handle);
  }

  private async doSyncFile(
    linkedFile: LinkedFileContext,
    options?: SyncFileOptions
  ): Promise<SyncOutcome> {
    const profile = getSyncProfile(linkedFile.entry.profileId);
    const baseTargetUri = this.getBaseTargetUri(linkedFile);
    options?.progress?.report("Checking Google metadata…");
    const access = await this.resolveLinkedFileAccess(linkedFile, profile);
    const { account, accessToken, metadata, rebound } = access;

    if (profile.targetFamily === "csv") {
      return this.doSpreadsheetSync(baseTargetUri, linkedFile, profile, metadata, accessToken, account, rebound, options);
    }

    const localText = await this.readLocalFileText(baseTargetUri);
    const needsAssetMigration = profile.localFormat === "markdown" && localText ? containsEmbeddedImageData(localText) : false;
    const trackedGeneratedFiles = await this.inspectTrackedGeneratedFiles(baseTargetUri, linkedFile.entry);
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

    const localState = await this.readLocalFileState(baseTargetUri, localText);
    if (needsOverwriteConfirmation(localState, linkedFile.entry.lastLocalHash)) {
      const selection = await vscode.window.showWarningMessage(
        `${path.basename(baseTargetUri.fsPath)} has local changes. Replace it with the latest Google content?`,
        { modal: true },
        "Overwrite"
      );
      if (selection !== "Overwrite") {
        return {
          status: "cancelled",
          message: "User kept the local Markdown changes."
        };
      }
    }

    const preparedContent =
      linkedFile.entry.lastDriveVersion &&
      metadata.version === linkedFile.entry.lastDriveVersion &&
      localText &&
      needsAssetMigration &&
      !trackedAssetsNeedRepair
        ? (() => {
            options?.progress?.report("Refreshing local Markdown image assets…");
            return extractMarkdownAssets(baseTargetUri.fsPath, localText);
          })()
        : await this.prepareMarkdownOutput(
            baseTargetUri.fsPath,
            accessToken,
            linkedFile.entry.fileId,
            linkedFile.entry.resourceKey,
            profile,
            metadata.name,
            options?.progress
          );
    options?.progress?.report("Writing local files…");
    await this.syncGeneratedFiles(baseTargetUri, this.getTrackedGeneratedFilePaths(linkedFile.entry), preparedContent.assets);
    await this.writeTextFile(baseTargetUri, preparedContent.markdown);
    const nextHash = sha256Text(preparedContent.markdown);
    await this.manifestStore.updateLinkedFile(baseTargetUri, (entry) => ({
      ...entry,
      outputKind: "file",
      accountId: account.accountId,
      accountEmail: account.accountEmail,
      title: metadata.name,
      sourceUrl: metadata.webViewLink || profile.buildSourceUrl(metadata.id),
      sourceMimeType: metadata.mimeType,
      resourceKey: metadata.resourceKey || entry.resourceKey,
      generatedFiles: preparedContent.assets.map((asset) => ({
        relativePath: asset.relativePath,
        contentHash: asset.contentHash
      })),
      lastDriveVersion: metadata.version,
      lastLocalHash: nextHash,
      lastSyncedAt: new Date().toISOString()
    }));

    if (options?.reason === "manual" || options?.reason === "link") {
      void vscode.window.setStatusBarMessage(`Synced ${path.basename(baseTargetUri.fsPath)} from Google`, 4000);
    }

    return {
      status: "synced",
      message: rebound
        ? `Synced ${path.basename(baseTargetUri.fsPath)} and rebound it to ${account.accountEmail || account.accountId}.`
        : `Synced ${path.basename(baseTargetUri.fsPath)}.`,
      rebind: rebound
    };
  }

  private async doSpreadsheetSync(
    baseTargetUri: vscode.Uri,
    linkedFile: LinkedFileContext,
    profile: SyncProfile,
    metadata: { id: string; name: string; mimeType: string; version: string; resourceKey?: string; webViewLink?: string },
    accessToken: string,
    account: ConnectedGoogleAccount,
    rebound: SyncOutcome["rebind"] | undefined,
    options?: SyncFileOptions
  ): Promise<SyncOutcome> {
    const outputState = await this.inspectSpreadsheetOutputState(baseTargetUri, linkedFile.entry);
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

    if (outputState.hasModified) {
      const selection = await vscode.window.showWarningMessage(
        `${path.basename(baseTargetUri.fsPath)} has local CSV changes. Replace them with the latest Google content?`,
        { modal: true },
        "Overwrite"
      );
      if (selection !== "Overwrite") {
        return {
          status: "cancelled",
          message: "User kept the local CSV changes."
        };
      }
    }

    options?.progress?.report(
      profile.retrievalMode === "drive-export-xlsx" ? "Exporting spreadsheet as Excel…" : "Downloading workbook…"
    );
    const workbookBytes = await this.fetchWorkbookBytes(accessToken, linkedFile.entry.fileId, linkedFile.entry.resourceKey, profile);
    const workbookOutput = parseWorkbookToCsvOutput(baseTargetUri.fsPath, workbookBytes);
    const syncSummary = buildSpreadsheetSyncSummary({
      baseTargetPath: baseTargetUri.fsPath,
      previousOutputKind: linkedFile.entry.outputKind,
      nextOutputKind: workbookOutput.outputKind,
      visibleSheetCount: workbookOutput.visibleSheetCount
    });

    if (workbookOutput.outputKind === "file" && workbookOutput.primaryFileText === undefined) {
      throw new Error("Spreadsheet sync did not produce a primary CSV file.");
    }

    options?.progress?.report(
      workbookOutput.outputKind === "directory" ? "Writing local CSV files…" : "Writing local CSV file…"
    );
    if (workbookOutput.outputKind === "directory") {
      await this.syncGeneratedFiles(baseTargetUri, this.getTrackedGeneratedFilePaths(linkedFile.entry), workbookOutput.generatedFiles);
      if (linkedFile.entry.outputKind === "file") {
        await this.deletePrimaryFile(baseTargetUri);
      }
    } else {
      await this.writeTextFile(baseTargetUri, workbookOutput.primaryFileText || "");
      await this.syncGeneratedFiles(baseTargetUri, this.getTrackedGeneratedFilePaths(linkedFile.entry), []);
    }

    const nextHash = workbookOutput.outputKind === "file" ? sha256Text(workbookOutput.primaryFileText || "") : undefined;
    await this.manifestStore.updateLinkedFile(baseTargetUri, (entry) => ({
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

    if (options?.reason === "manual" || options?.reason === "link") {
      void vscode.window.setStatusBarMessage(syncSummary, 5000);
    }

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
                  ? path.join(path.dirname(baseTargetUri.fsPath), path.parse(baseTargetUri.fsPath).name)
                  : undefined
            }
          : undefined
    };
  }

  private shouldTryAnotherAccount(error: unknown): boolean {
    if (error instanceof PickerGrantRequiredError) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes("cannot be refreshed") ||
      message.includes("No connected Google account matches") ||
      message.includes("cannot read file") ||
      message.includes("cannot access Google file") ||
      message.includes("missing the required Drive read-only scope")
    );
  }

  private async resolveLinkedFileAccess(
    linkedFile: LinkedFileContext,
    profile: SyncProfile
  ): Promise<{
    account: ConnectedGoogleAccount;
    accessToken: string;
    metadata: Awaited<ReturnType<DriveClient["getFileMetadata"]>>;
    rebound?: SyncOutcome["rebind"];
  }> {
    const candidates = await this.authManager.getAccountsInPriorityOrder(linkedFile.entry.accountId);
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
        // This read-only product can safely recover a broken binding by rebinding it.
        // Revisit this behavior if GDriveSync ever supports two-way sync.
        const rebound =
          linkedFile.entry.accountId && linkedFile.entry.accountId !== account.accountId
            ? {
                previousAccountId: linkedFile.entry.accountId,
                previousAccountEmail: linkedFile.entry.accountEmail,
                nextAccountId: account.accountId,
                nextAccountEmail: account.accountEmail
              }
            : undefined;
        return { account, accessToken, metadata, rebound };
      } catch (error) {
        lastError = error;
        if (!this.shouldTryAnotherAccount(error)) {
          throw error;
        }
      }
    }

    if (lastError instanceof PickerGrantRequiredError && linkedFile.entry.accountEmail) {
      throw new Error(
        `The bound Google account (${linkedFile.entry.accountEmail}) can no longer read file ${linkedFile.entry.fileId}, and no other connected account could recover it.`
      );
    }

    throw lastError || new Error("No connected Google account can access the linked file.");
  }

  private async readLocalFileState(fileUri: vscode.Uri, existingText?: string): Promise<LocalFileState> {
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === fileUri.toString());
    if (openDocument) {
      return {
        fileExists: true,
        isDirty: openDocument.isDirty,
        currentHash: sha256Text(openDocument.getText())
      };
    }

    if (existingText !== undefined) {
      return {
        fileExists: true,
        isDirty: false,
        currentHash: sha256Text(existingText)
      };
    }

    try {
      const rawValue = await readFile(fileUri.fsPath, "utf8");
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

  private async readLocalFileText(fileUri: vscode.Uri): Promise<string | undefined> {
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === fileUri.toString());
    if (openDocument) {
      return openDocument.getText();
    }

    try {
      return await readFile(fileUri.fsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
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
    title: string,
    progress?: SyncProgressReporter
  ) {
    if (profile.localFormat === "marp") {
      return this.preparePresentationOutput(markdownFilePath, accessToken, fileId, resourceKey, profile, title, progress);
    }

    if (profile.retrievalMode === "drive-download-docx") {
      progress?.report("Downloading Word document…");
    } else if (profile.retrievalMode === "drive-export-docx") {
      progress?.report("Exporting Google Doc as Word for higher-quality Markdown conversion…");
    } else {
      progress?.report("Exporting document as Markdown…");
    }
    const sourceText = await this.fetchSourceMarkdown(accessToken, fileId, resourceKey, profile);
    if (containsEmbeddedImageData(sourceText)) {
      progress?.report("Extracting embedded images…");
    }
    return extractMarkdownAssets(markdownFilePath, sourceText);
  }

  private async preparePresentationOutput(
    markdownFilePath: string,
    accessToken: string,
    fileId: string,
    resourceKey: string | undefined,
    profile: ReturnType<typeof getSyncProfile>,
    title: string,
    progress?: SyncProgressReporter
  ) {
    try {
      progress?.report(
        profile.retrievalMode === "drive-export-pptx" ? "Exporting presentation as PowerPoint…" : "Downloading PowerPoint presentation…"
      );
      const presentationBytes = await this.fetchPresentationBytes(accessToken, fileId, resourceKey, profile);
      return await convertPresentationToMarp(markdownFilePath, presentationBytes, {
        assetMode: "external",
        title
      });
    } catch (error) {
      if (profile.id === "google-slide-marp" && error instanceof GoogleApiError && error.reason === "exportSizeLimitExceeded") {
        progress?.report("Presentation too large for Drive export. Switching to the Google Slides API…");
        progress?.report("Loading slide structure…");
        const presentation = await this.slidesClient.getPresentation(accessToken, fileId);
        let lastReportedSlide = 0;
        return convertSlidesApiPresentationToMarp(
          markdownFilePath,
          presentation,
          {
            assetMode: "external",
            title,
            includeBackgrounds: this.includeSlidesApiFallbackBackgrounds(),
            onProgress: (completedSlides, totalSlides) => {
              if (
                completedSlides === totalSlides ||
                completedSlides === 1 ||
                completedSlides - lastReportedSlide >= 10
              ) {
                lastReportedSlide = completedSlides;
                progress?.report(`Rendering slides ${completedSlides}/${totalSlides}…`);
              }
            }
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

  private includeSlidesApiFallbackBackgrounds(): boolean {
    return vscode.workspace.getConfiguration("gdocSync").get<boolean>("slides.includeBackgroundsInApiFallback", false);
  }

  private async fetchWorkbookBytes(
    accessToken: string,
    fileId: string,
    resourceKey: string | undefined,
    profile: SyncProfile
  ): Promise<Uint8Array> {
    if (profile.retrievalMode === "drive-export-xlsx") {
      return this.driveClient.exportFile(accessToken, fileId, profile.exportMimeType, resourceKey);
    }

    return this.driveClient.downloadFile(accessToken, fileId, resourceKey);
  }

  private getBaseTargetUri(linkedFile: LinkedFileContext): vscode.Uri {
    return vscode.Uri.file(fromManifestKey(linkedFile.folderPath, linkedFile.key));
  }

  private getTrackedGeneratedFiles(entry: LinkedFileEntry): GeneratedFileRecord[] {
    return entry.generatedFiles || [];
  }

  private getTrackedGeneratedFilePaths(entry: LinkedFileEntry): string[] | undefined {
    const trackedGeneratedFiles = this.getTrackedGeneratedFiles(entry);
    return trackedGeneratedFiles.length > 0 ? trackedGeneratedFiles.map((generatedFile) => generatedFile.relativePath) : undefined;
  }

  private async inspectSpreadsheetOutputState(baseTargetUri: vscode.Uri, entry: LinkedFileEntry): Promise<TrackedOutputState> {
    if (entry.outputKind === "directory") {
      return this.inspectTrackedGeneratedFiles(baseTargetUri, entry);
    }

    const localText = await this.readLocalFileText(baseTargetUri);
    const localState = await this.readLocalFileState(baseTargetUri, localText);
    return {
      hasMissing: !localState.fileExists,
      hasModified: needsOverwriteConfirmation(localState, entry.lastLocalHash)
    };
  }

  private async inspectTrackedGeneratedFiles(baseTargetUri: vscode.Uri, entry: LinkedFileEntry): Promise<TrackedOutputState> {
    const trackedGeneratedFiles = this.getTrackedGeneratedFiles(entry);
    if (trackedGeneratedFiles.length === 0) {
      return { hasMissing: false, hasModified: false };
    }

    let hasMissing = false;
    let hasModified = false;
    const fileDirectory = path.dirname(baseTargetUri.fsPath);
    for (const generatedFile of trackedGeneratedFiles) {
      const absoluteUri = vscode.Uri.file(path.join(fileDirectory, ...generatedFile.relativePath.split("/")));
      const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === absoluteUri.toString());
      if (openDocument) {
        if (openDocument.isDirty) {
          hasModified = true;
          continue;
        }

        if (!generatedFile.contentHash) {
          hasMissing = true;
          continue;
        }

        const currentHash = sha256Text(openDocument.getText());
        if (currentHash !== generatedFile.contentHash) {
          hasModified = true;
        }
        continue;
      }

      let fileBytes: Uint8Array;
      try {
        fileBytes = await readFile(absoluteUri.fsPath);
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
    fileUri: vscode.Uri,
    previousGeneratedPaths: string[] | undefined,
    nextFiles: GeneratedFilePayload[]
  ): Promise<void> {
    const fileDirectory = path.dirname(fileUri.fsPath);
    const nextPaths = new Set(nextFiles.map((generatedFile) => generatedFile.relativePath));

    for (const generatedFile of nextFiles) {
      const absolutePath = path.join(fileDirectory, ...generatedFile.relativePath.split("/"));
      await mkdir(path.dirname(absolutePath), { recursive: true });
      if (generatedFile.mimeType === "text/csv") {
        await this.writeTextFile(vscode.Uri.file(absolutePath), Buffer.from(generatedFile.bytes).toString("utf8"));
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

  private async deletePrimaryFile(fileUri: vscode.Uri): Promise<void> {
    try {
      await unlink(fileUri.fsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async writeTextFile(fileUri: vscode.Uri, text: string): Promise<void> {
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === fileUri.toString());
    if (openDocument) {
      const fullRange = new vscode.Range(openDocument.positionAt(0), openDocument.positionAt(openDocument.getText().length));
      const edit = new vscode.WorkspaceEdit();
      edit.replace(fileUri, fullRange, text);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        throw new Error("VS Code could not update the open file.");
      }

      await openDocument.save();
      return;
    }

    await mkdir(path.dirname(fileUri.fsPath), { recursive: true });
    await writeFile(fileUri.fsPath, text, "utf8");
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Google sync failed.";
  }
}
