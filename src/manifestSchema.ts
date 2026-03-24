import { getSyncProfile, isSyncProfileId } from "./syncProfiles";
import { CorruptStateError } from "./stateErrors";
import { GeneratedFileRecord, SyncManifest, SyncOutputKind } from "./types";

function defaultManifest(): SyncManifest {
  return {
    version: 4,
    files: {}
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function normalizeOutputKind(value: unknown): SyncOutputKind {
  return value === "directory" ? "directory" : "file";
}

function normalizeGeneratedFiles(value: unknown): GeneratedFileRecord[] | undefined {
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
  return undefined;
}

function countRawManifestEntries(rawValue: unknown): number {
  if (!rawValue || typeof rawValue !== "object") {
    return 0;
  }

  const candidateFiles = (rawValue as { files?: unknown }).files;
  return candidateFiles && typeof candidateFiles === "object" ? Object.keys(candidateFiles as Record<string, unknown>).length : 0;
}

export interface ManifestInspection {
  manifest: SyncManifest;
  rawEntryCount: number;
  normalizedEntryCount: number;
  droppedEntryCount: number;
}

export function normalizeManifest(rawValue: unknown): SyncManifest {
  if (!rawValue || typeof rawValue !== "object") {
    return defaultManifest();
  }

  const candidate = rawValue as { version?: unknown; files?: unknown };
  if (candidate.version !== 4) {
    throw new CorruptStateError(
      "manifest",
      "manifest",
      `The saved GDriveSync manifest uses unsupported schema version ${String(candidate.version)}.`
    );
  }

  const manifest: SyncManifest = {
    version: 4,
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
    if (!isSyncProfileId(entry.profileId)) {
      continue;
    }

    const profileId = entry.profileId;
    const profile = getSyncProfile(profileId);
    const fileId = isString(entry.fileId) ? entry.fileId : undefined;
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
      accountId: isString(entry.accountId) ? entry.accountId : undefined,
      accountEmail: isString(entry.accountEmail) ? entry.accountEmail : undefined,
      resourceKey: isString(entry.resourceKey) ? entry.resourceKey : undefined,
      generatedFiles: normalizeGeneratedFiles(entry.generatedFiles),
      lastSyncedAt: isString(entry.lastSyncedAt) ? entry.lastSyncedAt : undefined,
      lastDriveVersion: isString(entry.lastDriveVersion) ? entry.lastDriveVersion : undefined,
      lastLocalHash: isString(entry.lastLocalHash) ? entry.lastLocalHash : undefined
    };
  }

  return manifest;
}

export function inspectManifestValue(rawValue: unknown): ManifestInspection {
  const manifest = normalizeManifest(rawValue);
  const rawEntryCount = countRawManifestEntries(rawValue);
  const normalizedEntryCount = Object.keys(manifest.files).length;
  return {
    manifest,
    rawEntryCount,
    normalizedEntryCount,
    droppedEntryCount: Math.max(0, rawEntryCount - normalizedEntryCount)
  };
}

export function parseManifestText(rawValue: string, stateLocation: string): ManifestInspection {
  try {
    const parsed = JSON.parse(rawValue);
    if (parsed && typeof parsed === "object" && (parsed as { version?: unknown }).version !== 4) {
      throw new CorruptStateError(
        "manifest",
        stateLocation,
        `The saved GDriveSync manifest at ${stateLocation} uses unsupported schema version ${String(
          (parsed as { version?: unknown }).version
        )}.`
      );
    }
    return inspectManifestValue(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CorruptStateError("manifest", stateLocation);
    }

    throw error;
  }
}
