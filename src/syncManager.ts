import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import * as vscode from "vscode";

import { DriveClient } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { ManifestStore } from "./manifestStore";
import { LocalFileState, needsOverwriteConfirmation } from "./overwritePolicy";
import { PickerSelection, SyncOutcome } from "./types";
import { sha256Text } from "./utils/hash";

export class SyncManager {
  private readonly inFlightSyncs = new Map<string, Promise<SyncOutcome>>();
  private readonly openDebounce = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly authManager: GoogleAuthManager,
    private readonly driveClient: DriveClient,
    private readonly manifestStore: ManifestStore
  ) {}

  async linkFile(fileUri: vscode.Uri, selection: PickerSelection): Promise<SyncOutcome> {
    const syncOnOpen = vscode.workspace.getConfiguration("gdocSync").get<boolean>("syncOnOpenDefault", false);
    await this.manifestStore.linkFile(fileUri, {
      docId: selection.docId,
      sourceUrl: selection.sourceUrl,
      resourceKey: selection.resourceKey,
      title: selection.title,
      syncOnOpen,
      lastDriveVersion: undefined,
      lastLocalHash: undefined,
      lastSyncedAt: undefined
    });
    return this.syncFile(fileUri, { reason: "link" });
  }

  async toggleSyncOnOpen(fileUri: vscode.Uri): Promise<boolean> {
    const context = await this.manifestStore.updateLinkedFile(fileUri, (entry) => ({
      ...entry,
      syncOnOpen: !entry.syncOnOpen
    }));
    return context.entry.syncOnOpen;
  }

  async syncFile(fileUri: vscode.Uri, options?: { reason?: "manual" | "open" | "link" }): Promise<SyncOutcome> {
    const syncKey = fileUri.toString();
    const activeSync = this.inFlightSyncs.get(syncKey);
    if (activeSync) {
      return activeSync;
    }

    const syncTask = this.doSyncFile(fileUri, options).finally(() => {
      this.inFlightSyncs.delete(syncKey);
    });
    this.inFlightSyncs.set(syncKey, syncTask);
    return syncTask;
  }

  async syncAll(): Promise<{ results: Array<{ file: string; outcome: SyncOutcome }>; syncedCount: number }> {
    const linkedFiles = await this.manifestStore.listLinkedFiles();
    const results: Array<{ file: string; outcome: SyncOutcome }> = [];
    let syncedCount = 0;
    for (const linkedFile of linkedFiles) {
      const outcome = await this.syncFile(linkedFile.fileUri, { reason: "manual" });
      if (outcome.status === "synced") {
        syncedCount += 1;
      }

      results.push({
        file: linkedFile.fileUri.fsPath,
        outcome
      });
    }

    return { results, syncedCount };
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
          void vscode.window.setStatusBarMessage(`Synced ${path.basename(fileUri.fsPath)} from Google Docs`, 3500);
        }
      } catch (error) {
        void vscode.window.showErrorMessage(this.toErrorMessage(error));
      }
    }, 600);

    this.openDebounce.set(key, handle);
  }

  private async doSyncFile(fileUri: vscode.Uri, options?: { reason?: "manual" | "open" | "link" }): Promise<SyncOutcome> {
    const linkedFile = await this.manifestStore.getLinkedFile(fileUri);
    if (!linkedFile) {
      throw new Error("This Markdown file is not linked to a Google Doc yet.");
    }

    const accessToken = await this.authManager.getAccessToken();
    const metadata = await this.driveClient.getFileMetadata(accessToken, linkedFile.entry.docId, linkedFile.entry.resourceKey);
    if (linkedFile.entry.lastDriveVersion && metadata.version === linkedFile.entry.lastDriveVersion) {
      return {
        status: "skipped",
        message: "Remote version unchanged."
      };
    }

    const localState = await this.readLocalFileState(fileUri);
    if (needsOverwriteConfirmation(localState, linkedFile.entry.lastLocalHash)) {
      const selection = await vscode.window.showWarningMessage(
        `${path.basename(fileUri.fsPath)} has local changes. Replace it with the latest Google Doc content?`,
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

    const markdown = await this.driveClient.exportMarkdown(accessToken, linkedFile.entry.docId, linkedFile.entry.resourceKey);
    await this.writeMarkdown(fileUri, markdown);
    const nextHash = sha256Text(markdown);
    await this.manifestStore.updateLinkedFile(fileUri, (entry) => ({
      ...entry,
      title: metadata.name,
      sourceUrl: metadata.webViewLink || entry.sourceUrl,
      resourceKey: metadata.resourceKey || entry.resourceKey,
      lastDriveVersion: metadata.version,
      lastLocalHash: nextHash,
      lastSyncedAt: new Date().toISOString()
    }));

    if (options?.reason === "manual" || options?.reason === "link") {
      void vscode.window.setStatusBarMessage(`Synced ${path.basename(fileUri.fsPath)} from Google Docs`, 4000);
    }

    return {
      status: "synced",
      message: `Synced ${path.basename(fileUri.fsPath)}.`
    };
  }

  private async readLocalFileState(fileUri: vscode.Uri): Promise<LocalFileState> {
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === fileUri.toString());
    if (openDocument) {
      return {
        fileExists: true,
        isDirty: openDocument.isDirty,
        currentHash: sha256Text(openDocument.getText())
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

  private async writeMarkdown(fileUri: vscode.Uri, markdown: string): Promise<void> {
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === fileUri.toString());
    if (openDocument) {
      const fullRange = new vscode.Range(openDocument.positionAt(0), openDocument.positionAt(openDocument.getText().length));
      const edit = new vscode.WorkspaceEdit();
      edit.replace(fileUri, fullRange, markdown);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        throw new Error("VS Code could not update the open Markdown document.");
      }

      await openDocument.save();
      return;
    }

    await mkdir(path.dirname(fileUri.fsPath), { recursive: true });
    await writeFile(fileUri.fsPath, markdown, "utf8");
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Google Docs sync failed.";
  }
}
