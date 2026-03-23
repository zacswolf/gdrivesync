import { SyncProfileId } from "./types";
import { buildGoogleDocUrl } from "./utils/docUrl";

export interface SyncProfile {
  id: SyncProfileId;
  label: string;
  sourceTypeLabel: string;
  sourceMimeType: string;
  exportMimeType: string;
  localFormat: string;
  targetFileExtension: string;
  pickerViewId: string;
  pickerMimeTypes: string;
  buildSourceUrl(fileId: string): string;
}

export const GOOGLE_DOC_MARKDOWN_PROFILE: SyncProfile = {
  id: "google-doc-markdown",
  label: "Google Doc to Markdown",
  sourceTypeLabel: "Google Doc",
  sourceMimeType: "application/vnd.google-apps.document",
  exportMimeType: "text/markdown",
  localFormat: "markdown",
  targetFileExtension: "md",
  pickerViewId: "DOCUMENTS",
  pickerMimeTypes: "application/vnd.google-apps.document",
  buildSourceUrl: buildGoogleDocUrl
};

const SYNC_PROFILES: Record<SyncProfileId, SyncProfile> = {
  [GOOGLE_DOC_MARKDOWN_PROFILE.id]: GOOGLE_DOC_MARKDOWN_PROFILE
};

export function getDefaultSyncProfile(): SyncProfile {
  return GOOGLE_DOC_MARKDOWN_PROFILE;
}

export function isSyncProfileId(value: unknown): value is SyncProfileId {
  return typeof value === "string" && value in SYNC_PROFILES;
}

export function getSyncProfile(profileId: SyncProfileId): SyncProfile {
  return SYNC_PROFILES[profileId];
}
