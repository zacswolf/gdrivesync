import { getDefaultSyncProfile, getSyncProfile, isSyncProfileId } from "./syncProfiles";
import { SyncManifest } from "./types";

function defaultManifest(): SyncManifest {
  return {
    version: 2,
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

export function normalizeManifest(rawValue: unknown): SyncManifest {
  if (!rawValue || typeof rawValue !== "object") {
    return defaultManifest();
  }

  const candidate = rawValue as { version?: unknown; files?: unknown };
  const manifest: SyncManifest = {
    version: 2,
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
      title: entry.title,
      syncOnOpen: entry.syncOnOpen,
      resourceKey: isString(entry.resourceKey) ? entry.resourceKey : undefined,
      generatedAssetPaths: toStringArray(entry.generatedAssetPaths),
      lastSyncedAt: isString(entry.lastSyncedAt) ? entry.lastSyncedAt : undefined,
      lastDriveVersion: isString(entry.lastDriveVersion) ? entry.lastDriveVersion : undefined,
      lastLocalHash: isString(entry.lastLocalHash) ? entry.lastLocalHash : undefined
    };
  }

  return manifest;
}
