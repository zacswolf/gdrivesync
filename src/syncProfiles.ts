import { SyncProfileId } from "./types";
import { buildGoogleDocUrl, buildGoogleDriveFileUrl } from "./utils/docUrl";

export type SyncRetrievalMode = "drive-export-markdown" | "drive-download-docx";

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
  retrievalMode: SyncRetrievalMode;
  buildSourceUrl(fileId: string): string;
}

export const GOOGLE_DOC_MARKDOWN_PROFILE: SyncProfile = {
  id: "google-doc-markdown",
  label: "Google file to Markdown",
  sourceTypeLabel: "Google file",
  sourceMimeType: "application/vnd.google-apps.document",
  exportMimeType: "text/markdown",
  localFormat: "markdown",
  targetFileExtension: "md",
  pickerViewId: "DOCUMENTS",
  pickerMimeTypes: "application/vnd.google-apps.document,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  retrievalMode: "drive-export-markdown",
  buildSourceUrl: buildGoogleDocUrl
};

export const WORD_DOCX_MARKDOWN_PROFILE: SyncProfile = {
  id: "word-docx-markdown",
  label: "Word DOCX to Markdown",
  sourceTypeLabel: "Word document",
  sourceMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  exportMimeType: "text/markdown",
  localFormat: "markdown",
  targetFileExtension: "md",
  pickerViewId: "DOCUMENTS",
  pickerMimeTypes: GOOGLE_DOC_MARKDOWN_PROFILE.pickerMimeTypes,
  retrievalMode: "drive-download-docx",
  buildSourceUrl: buildGoogleDriveFileUrl
};

const SYNC_PROFILES = {
  "google-doc-markdown": GOOGLE_DOC_MARKDOWN_PROFILE,
  "word-docx-markdown": WORD_DOCX_MARKDOWN_PROFILE
} satisfies Record<SyncProfileId, SyncProfile>;

const PROFILE_IDS = Object.keys(SYNC_PROFILES) as SyncProfileId[];

export function getDefaultSyncProfile(): SyncProfile {
  return GOOGLE_DOC_MARKDOWN_PROFILE;
}

export function getSupportedSyncProfiles(): SyncProfile[] {
  return PROFILE_IDS.map((profileId) => SYNC_PROFILES[profileId]);
}

export function getSupportedSourceMimeTypes(): string[] {
  return getSupportedSyncProfiles().map((profile) => profile.sourceMimeType);
}

export function resolveSyncProfileForMimeType(mimeType: string): SyncProfile | undefined {
  return getSupportedSyncProfiles().find((profile) => profile.sourceMimeType === mimeType);
}

export function isSyncProfileId(value: unknown): value is SyncProfileId {
  return typeof value === "string" && value in SYNC_PROFILES;
}

export function getSyncProfile(profileId: SyncProfileId): SyncProfile {
  return SYNC_PROFILES[profileId];
}
