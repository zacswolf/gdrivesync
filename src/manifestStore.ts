import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import * as vscode from "vscode";

import { normalizeManifest } from "./manifestSchema";
import { LinkedFileContext, LinkedFileEntry, SyncManifest } from "./types";
import { fromManifestKey, toManifestKey } from "./utils/paths";

const MANIFEST_FILE_NAME = ".gdrivesync.json";
const LEGACY_MANIFEST_FILE_NAME = ".gdocsync.json";
const defaultManifest = (): SyncManifest => ({ version: 3, files: {} });

function sortManifest(manifest: SyncManifest): SyncManifest {
  return {
    version: manifest.version,
    files: Object.fromEntries(Object.entries(manifest.files).sort(([left], [right]) => left.localeCompare(right)))
  };
}

export class ManifestStore {
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
    return (entry.generatedFiles || entry.generatedFilePaths || []).some((generatedFile) =>
      typeof generatedFile === "string" ? generatedFile === candidateKey : generatedFile.relativePath === candidateKey
    );
  }

  getManifestPath(folderPath: string): string {
    return path.join(folderPath, MANIFEST_FILE_NAME);
  }

  getLegacyManifestPath(folderPath: string): string {
    return path.join(folderPath, LEGACY_MANIFEST_FILE_NAME);
  }

  async readManifest(folderPath: string): Promise<SyncManifest> {
    try {
      const rawValue = await readFile(this.getManifestPath(folderPath), "utf8");
      return normalizeManifest(JSON.parse(rawValue));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    try {
      const rawValue = await readFile(this.getLegacyManifestPath(folderPath), "utf8");
      return normalizeManifest(JSON.parse(rawValue));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultManifest();
      }

      throw error;
    }
  }

  async writeManifest(folderPath: string, manifest: SyncManifest): Promise<void> {
    await mkdir(folderPath, { recursive: true });
    await writeFile(this.getManifestPath(folderPath), `${JSON.stringify(sortManifest(manifest), null, 2)}\n`, "utf8");
    await rm(this.getLegacyManifestPath(folderPath), { force: true });
  }

  async getLinkedFile(fileUri: vscode.Uri): Promise<LinkedFileContext | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!folder) {
      return undefined;
    }

    const manifest = await this.readManifest(folder.uri.fsPath);
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

  async linkFile(fileUri: vscode.Uri, entry: LinkedFileEntry): Promise<LinkedFileContext> {
    const folder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!folder) {
      throw new Error("Linking requires the local file to live inside an open workspace folder.");
    }

    const manifest = await this.readManifest(folder.uri.fsPath);
    const key = toManifestKey(folder.uri.fsPath, fileUri.fsPath);
    manifest.files[key] = entry;
    await this.writeManifest(folder.uri.fsPath, manifest);
    return this.buildContext(folder, key, key, "primary", entry);
  }

  async updateLinkedFile(fileUri: vscode.Uri, updater: (entry: LinkedFileEntry) => LinkedFileEntry): Promise<LinkedFileContext> {
    const context = await this.getLinkedFile(fileUri);
    if (!context) {
      throw new Error("This file is not linked to Google.");
    }

    const manifest = await this.readManifest(context.folderPath);
    const nextEntry = updater(context.entry);
    manifest.files[context.key] = nextEntry;
    await this.writeManifest(context.folderPath, manifest);
    return {
      ...context,
      entry: nextEntry
    };
  }

  async unlinkFile(fileUri: vscode.Uri): Promise<boolean> {
    const context = await this.getLinkedFile(fileUri);
    if (!context) {
      return false;
    }

    const manifest = await this.readManifest(context.folderPath);
    delete manifest.files[context.key];
    await this.writeManifest(context.folderPath, manifest);
    return true;
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
