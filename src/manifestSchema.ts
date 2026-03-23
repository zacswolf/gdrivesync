import { SyncManifest } from "./types";

function defaultManifest(): SyncManifest {
  return {
    version: 1,
    files: {}
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function normalizeManifest(rawValue: unknown): SyncManifest {
  if (!rawValue || typeof rawValue !== "object") {
    return defaultManifest();
  }

  const candidate = rawValue as { version?: unknown; files?: unknown };
  const manifest: SyncManifest = {
    version: candidate.version === 1 ? 1 : 1,
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
    if (!isString(entry.docId) || !isString(entry.sourceUrl) || !isString(entry.title) || typeof entry.syncOnOpen !== "boolean") {
      continue;
    }

    manifest.files[key] = {
      docId: entry.docId,
      sourceUrl: entry.sourceUrl,
      title: entry.title,
      syncOnOpen: entry.syncOnOpen,
      resourceKey: isString(entry.resourceKey) ? entry.resourceKey : undefined,
      lastSyncedAt: isString(entry.lastSyncedAt) ? entry.lastSyncedAt : undefined,
      lastDriveVersion: isString(entry.lastDriveVersion) ? entry.lastDriveVersion : undefined,
      lastLocalHash: isString(entry.lastLocalHash) ? entry.lastLocalHash : undefined
    };
  }

  return manifest;
}
