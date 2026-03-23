import { getDefaultSyncProfile, getSyncProfile, isSyncProfileId } from "./syncProfiles";
import { GeneratedFileRecord, SyncManifest, SyncOutputKind } from "./types";

function defaultManifest(): SyncManifest {
  return {
    version: 3,
    files: {}
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value.filter(isString);
  return items.length > 0 ? items : undefined;
}

function normalizeOutputKind(value: unknown): SyncOutputKind {
  return value === "directory" ? "directory" : "file";
}

function normalizeGeneratedFiles(value: unknown, fallbackPaths: string[] | undefined): GeneratedFileRecord[] | undefined {
  if (Array.isArray(value)) {
    const items: GeneratedFileRecord[] = [];
    for (const candidate of value) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }

      const entry = candidate as Record<string, unknown>;
      if (!isString(entry.relativePath)) {
        continue;
      }

      items.push({
        relativePath: entry.relativePath,
        contentHash: isString(entry.contentHash) ? entry.contentHash : undefined
      });
    }

    if (items.length > 0) {
      return items;
    }
  }

  if (!fallbackPaths || fallbackPaths.length === 0) {
    return undefined;
  }

  return fallbackPaths.map((relativePath) => ({ relativePath }));
}

export function normalizeManifest(rawValue: unknown): SyncManifest {
  if (!rawValue || typeof rawValue !== "object") {
    return defaultManifest();
  }

  const candidate = rawValue as { version?: unknown; files?: unknown };
  const manifest: SyncManifest = {
    version: 3,
    files: {}
  };

  const files = candidate.files;
  if (!files || typeof files !== "object") {
    return manifest;
  }

  for (const [key, value] of Object.entries(files as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const entry = value as Record<string, unknown>;
    const profileId = isSyncProfileId(entry.profileId) ? entry.profileId : getDefaultSyncProfile().id;
    const profile = getSyncProfile(profileId);
    const fileId = isString(entry.fileId) ? entry.fileId : isString(entry.docId) ? entry.docId : undefined;
    const generatedFilePaths = toStringArray(entry.generatedFilePaths) || toStringArray(entry.generatedAssetPaths);
    if (!fileId || !isString(entry.sourceUrl) || !isString(entry.title) || typeof entry.syncOnOpen !== "boolean") {
      continue;
    }

    manifest.files[key] = {
      profileId,
      fileId,
      sourceUrl: entry.sourceUrl,
      sourceMimeType: isString(entry.sourceMimeType) ? entry.sourceMimeType : profile.sourceMimeType,
      exportMimeType: isString(entry.exportMimeType) ? entry.exportMimeType : profile.exportMimeType,
      localFormat: isString(entry.localFormat) ? entry.localFormat : profile.localFormat,
      outputKind: normalizeOutputKind(entry.outputKind),
      title: entry.title,
      syncOnOpen: entry.syncOnOpen,
      resourceKey: isString(entry.resourceKey) ? entry.resourceKey : undefined,
      generatedFiles: normalizeGeneratedFiles(entry.generatedFiles || entry.generatedAssets, generatedFilePaths),
      generatedFilePaths,
      lastSyncedAt: isString(entry.lastSyncedAt) ? entry.lastSyncedAt : undefined,
      lastDriveVersion: isString(entry.lastDriveVersion) ? entry.lastDriveVersion : undefined,
      lastLocalHash: isString(entry.lastLocalHash) ? entry.lastLocalHash : undefined
    };
  }

  return manifest;
}
