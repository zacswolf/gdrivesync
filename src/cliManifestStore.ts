import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseManifestText } from "./manifestSchema";
import { ManifestBusyError } from "./stateErrors";
import { LinkedFileContext, LinkedFileEntry, SyncManifest } from "./types";
import { writeFileAtomically } from "./utils/atomicWrite";
import { FileLockTimeoutError, withFileLock } from "./utils/fileLock";
import { fromManifestKey, toManifestKey } from "./utils/paths";

const MANIFEST_FILE_NAME = ".gdrivesync.json";

function defaultManifest(): SyncManifest {
  return { version: 4, files: {} };
}

function sortManifest(manifest: SyncManifest): SyncManifest {
  return {
    version: manifest.version,
    files: Object.fromEntries(Object.entries(manifest.files).sort(([left], [right]) => left.localeCompare(right)))
  };
}

export class CliManifestStore {
  constructor(private readonly rootPath: string) {}

  private findLinkedFileContext(manifest: SyncManifest, filePath: string): LinkedFileContext | undefined {
    const candidateKey = this.getManifestKeyForPath(filePath);
    const exactEntry = manifest.files[candidateKey];
    if (exactEntry) {
      return this.buildContext(candidateKey, candidateKey, "primary", exactEntry);
    }

    for (const [entryKey, entry] of Object.entries(manifest.files)) {
      if (this.matchesGeneratedOutput(entry, candidateKey)) {
        return this.buildContext(entryKey, candidateKey, "generated", entry);
      }
    }

    return undefined;
  }

  private async withManifestLock<T>(task: () => Promise<T>): Promise<T> {
    const manifestPath = this.getManifestPath();
    try {
      return await withFileLock(manifestPath, "cli", task);
    } catch (error) {
      if (error instanceof FileLockTimeoutError) {
        throw new ManifestBusyError(manifestPath);
      }

      throw error;
    }
  }

  private buildContext(
    entryKey: string,
    matchedRelativePath: string,
    matchedOutputKind: "primary" | "generated",
    entry: LinkedFileEntry
  ): LinkedFileContext {
    return {
      folderPath: this.rootPath,
      folderName: path.basename(this.rootPath),
      manifestPath: this.getManifestPath(),
      key: entryKey,
      matchedRelativePath,
      matchedOutputKind,
      entry
    };
  }

  private matchesGeneratedOutput(entry: LinkedFileEntry, candidateKey: string): boolean {
    return (entry.generatedFiles || []).some((generatedFile) => generatedFile.relativePath === candidateKey);
  }

  getManifestPath(): string {
    return path.join(this.rootPath, MANIFEST_FILE_NAME);
  }

  getAbsolutePathForKey(key: string): string {
    return fromManifestKey(this.rootPath, key);
  }

  getManifestKeyForPath(filePath: string): string {
    return toManifestKey(this.rootPath, path.resolve(filePath));
  }

  async readManifest(): Promise<SyncManifest> {
    try {
      const rawValue = await readFile(this.getManifestPath(), "utf8");
      return parseManifestText(rawValue, this.getManifestPath()).manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultManifest();
      }

      throw error;
    }
  }

  async writeManifest(manifest: SyncManifest): Promise<void> {
    await this.withManifestLock(async () => {
      await this.writeManifestUnlocked(manifest);
    });
  }

  private async writeManifestUnlocked(manifest: SyncManifest): Promise<void> {
    await writeFileAtomically(this.getManifestPath(), `${JSON.stringify(sortManifest(manifest), null, 2)}\n`, {
      encoding: "utf8"
    });
  }

  async getLinkedFile(filePath: string): Promise<LinkedFileContext | undefined> {
    const manifest = await this.readManifest();
    return this.findLinkedFileContext(manifest, filePath);
  }

  async linkFile(filePath: string, entry: LinkedFileEntry): Promise<LinkedFileContext> {
    return this.withManifestLock(async () => {
      const manifest = await this.readManifest();
      const key = this.getManifestKeyForPath(filePath);
      manifest.files[key] = entry;
      await this.writeManifestUnlocked(manifest);
      return this.buildContext(key, key, "primary", entry);
    });
  }

  async updateLinkedFile(filePath: string, updater: (entry: LinkedFileEntry) => LinkedFileEntry): Promise<LinkedFileContext> {
    return this.withManifestLock(async () => {
      const manifest = await this.readManifest();
      const context = this.findLinkedFileContext(manifest, filePath);
      if (!context) {
        throw new Error("This file is not linked to Google.");
      }

      const nextEntry = updater(context.entry);
      manifest.files[context.key] = nextEntry;
      await this.writeManifestUnlocked(manifest);
      return {
        ...context,
        entry: nextEntry
      };
    });
  }

  async unlinkFile(filePath: string): Promise<boolean> {
    return this.withManifestLock(async () => {
      const manifest = await this.readManifest();
      const context = this.findLinkedFileContext(manifest, filePath);
      if (!context) {
        return false;
      }

      delete manifest.files[context.key];
      await this.writeManifestUnlocked(manifest);
      return true;
    });
  }

  async listLinkedFiles(): Promise<Array<{ filePath: string; context: LinkedFileContext }>> {
    const manifest = await this.readManifest();
    return Object.entries(manifest.files).map(([key, entry]) => ({
      filePath: this.getAbsolutePathForKey(key),
      context: this.buildContext(key, key, "primary", entry)
    }));
  }
}
