import { readFile } from "node:fs/promises";
import path from "node:path";

import * as vscode from "vscode";

import { parseManifestText } from "./manifestSchema";
import { ManifestBusyError } from "./stateErrors";
import { LinkedFileContext, LinkedFileEntry, SyncManifest } from "./types";
import { writeFileAtomically } from "./utils/atomicWrite";
import { FileLockTimeoutError, withFileLock } from "./utils/fileLock";
import { fromManifestKey, toManifestKey } from "./utils/paths";

const MANIFEST_FILE_NAME = ".gdrivesync.json";
const defaultManifest = (): SyncManifest => ({ version: 4, files: {} });

function sortManifest(manifest: SyncManifest): SyncManifest {
  return {
    version: manifest.version,
    files: Object.fromEntries(Object.entries(manifest.files).sort(([left], [right]) => left.localeCompare(right)))
  };
}

export class ManifestStore {
  private findLinkedFileContext(
    folder: vscode.WorkspaceFolder,
    manifest: SyncManifest,
    fileUri: vscode.Uri
  ): LinkedFileContext | undefined {
    const candidateKey = toManifestKey(folder.uri.fsPath, fileUri.fsPath);
    const exactEntry = manifest.files[candidateKey];
    if (exactEntry) {
      return this.buildContext(folder, candidateKey, candidateKey, "primary", exactEntry);
    }

    for (const [entryKey, entry] of Object.entries(manifest.files)) {
      if (this.matchesGeneratedOutput(entry, candidateKey)) {
        return this.buildContext(folder, entryKey, candidateKey, "generated", entry);
      }
    }

    return undefined;
  }

  private async withManifestLock<T>(folderPath: string, task: () => Promise<T>): Promise<T> {
    const manifestPath = this.getManifestPath(folderPath);
    try {
      return await withFileLock(manifestPath, "extension", task);
    } catch (error) {
      if (error instanceof FileLockTimeoutError) {
        throw new ManifestBusyError(manifestPath);
      }

      throw error;
    }
  }

  private buildContext(
    folder: vscode.WorkspaceFolder,
    entryKey: string,
    matchedRelativePath: string,
    matchedOutputKind: "primary" | "generated",
    entry: LinkedFileEntry
  ): LinkedFileContext {
    return {
      folderPath: folder.uri.fsPath,
      folderName: folder.name,
      manifestPath: this.getManifestPath(folder.uri.fsPath),
      key: entryKey,
      matchedRelativePath,
      matchedOutputKind,
      entry
    };
  }

  private matchesGeneratedOutput(entry: LinkedFileEntry, candidateKey: string): boolean {
    return (entry.generatedFiles || []).some((generatedFile) => generatedFile.relativePath === candidateKey);
  }

  getManifestPath(folderPath: string): string {
    return path.join(folderPath, MANIFEST_FILE_NAME);
  }

  async readManifest(folderPath: string): Promise<SyncManifest> {
    try {
      const rawValue = await readFile(this.getManifestPath(folderPath), "utf8");
      return parseManifestText(rawValue, this.getManifestPath(folderPath)).manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultManifest();
      }

      throw error;
    }
  }

  async writeManifest(folderPath: string, manifest: SyncManifest): Promise<void> {
    await this.withManifestLock(folderPath, async () => {
      await this.writeManifestUnlocked(folderPath, manifest);
    });
  }

  private async writeManifestUnlocked(folderPath: string, manifest: SyncManifest): Promise<void> {
    await writeFileAtomically(this.getManifestPath(folderPath), `${JSON.stringify(sortManifest(manifest), null, 2)}\n`, {
      encoding: "utf8"
    });
  }

  async getLinkedFile(fileUri: vscode.Uri): Promise<LinkedFileContext | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!folder) {
      return undefined;
    }

    const manifest = await this.readManifest(folder.uri.fsPath);
    return this.findLinkedFileContext(folder, manifest, fileUri);
  }

  async linkFile(fileUri: vscode.Uri, entry: LinkedFileEntry): Promise<LinkedFileContext> {
    const folder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!folder) {
      throw new Error("Linking requires the local file to live inside an open workspace folder.");
    }

    return this.withManifestLock(folder.uri.fsPath, async () => {
      const manifest = await this.readManifest(folder.uri.fsPath);
      const key = toManifestKey(folder.uri.fsPath, fileUri.fsPath);
      manifest.files[key] = entry;
      await this.writeManifestUnlocked(folder.uri.fsPath, manifest);
      return this.buildContext(folder, key, key, "primary", entry);
    });
  }

  async updateLinkedFile(fileUri: vscode.Uri, updater: (entry: LinkedFileEntry) => LinkedFileEntry): Promise<LinkedFileContext> {
    const folder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!folder) {
      throw new Error("This file is not linked to Google.");
    }

    return this.withManifestLock(folder.uri.fsPath, async () => {
      const manifest = await this.readManifest(folder.uri.fsPath);
      const context = this.findLinkedFileContext(folder, manifest, fileUri);
      if (!context) {
        throw new Error("This file is not linked to Google.");
      }

      const nextEntry = updater(context.entry);
      manifest.files[context.key] = nextEntry;
      await this.writeManifestUnlocked(folder.uri.fsPath, manifest);
      return {
        ...context,
        entry: nextEntry
      };
    });
  }

  async unlinkFile(fileUri: vscode.Uri): Promise<boolean> {
    const folder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!folder) {
      return false;
    }

    return this.withManifestLock(folder.uri.fsPath, async () => {
      const manifest = await this.readManifest(folder.uri.fsPath);
      const context = this.findLinkedFileContext(folder, manifest, fileUri);
      if (!context) {
        return false;
      }

      delete manifest.files[context.key];
      await this.writeManifestUnlocked(folder.uri.fsPath, manifest);
      return true;
    });
  }

  async listLinkedFiles(): Promise<Array<{ fileUri: vscode.Uri; context: LinkedFileContext }>> {
    const folders = vscode.workspace.workspaceFolders || [];
    const results: Array<{ fileUri: vscode.Uri; context: LinkedFileContext }> = [];
    for (const folder of folders) {
      const manifest = await this.readManifest(folder.uri.fsPath);
      for (const [key, entry] of Object.entries(manifest.files)) {
        results.push({
          fileUri: vscode.Uri.file(fromManifestKey(folder.uri.fsPath, key)),
          context: this.buildContext(folder, key, key, "primary", entry)
        });
      }
    }

    return results;
  }
}
