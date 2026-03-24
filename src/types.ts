export type SyncProfileId =
  | "google-doc-markdown"
  | "word-docx-markdown"
  | "google-slide-marp"
  | "powerpoint-pptx-marp"
  | "google-sheet-csv"
  | "excel-xlsx-csv";

export type SyncOutputKind = "file" | "directory";
export type LinkedFileMatchKind = "primary" | "generated";

export interface LinkedFileEntry {
  profileId: SyncProfileId;
  fileId: string;
  sourceUrl: string;
  sourceMimeType: string;
  exportMimeType: string;
  localFormat: string;
  outputKind: SyncOutputKind;
  resourceKey?: string;
  title: string;
  syncOnOpen: boolean;
  accountId?: string;
  accountEmail?: string;
  generatedFiles?: GeneratedFileRecord[];
  lastSyncedAt?: string;
  lastDriveVersion?: string;
  lastLocalHash?: string;
}

export interface SyncManifest {
  version: 4;
  files: Record<string, LinkedFileEntry>;
}

export interface GoogleReleaseConfig {
  desktopClientId: string;
  desktopClientSecret?: string;
  hostedBaseUrl: string;
  oauthBridgeUrl: string;
  pickerUrl: string;
  scope: string;
  loginHint?: string;
}

export interface StoredOAuthSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
  tokenType: string;
}

export interface ConnectedGoogleAccount {
  accountId: string;
  accountEmail?: string;
  accountDisplayName?: string;
  session: StoredOAuthSession;
}

export interface StoredOAuthState {
  version: 1;
  defaultAccountId?: string;
  accounts: Record<string, ConnectedGoogleAccount>;
}

export interface OAuthStatePayload {
  nonce: string;
  localRedirect?: string;
}

export interface PickerRequestPayload {
  nonce: string;
  localRedirect: string;
  sourceTypeLabel: string;
  pickerViewId: string;
  pickerMimeTypes: string;
  supportedMimeTypes: string[];
  hintFileId?: string;
  resourceKey?: string;
  loginHint?: string;
}

export interface ResolvedGoogleFile {
  fileId: string;
  title: string;
  sourceUrl: string;
  sourceMimeType: string;
  resourceKey?: string;
}

export interface PickerSelection {
  profileId: SyncProfileId;
  fileId: string;
  title: string;
  sourceUrl: string;
  sourceMimeType: string;
  resourceKey?: string;
  accountId?: string;
  accountEmail?: string;
  accountDisplayName?: string;
}

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  version: string;
  modifiedTime?: string;
  resourceKey?: string;
  webViewLink?: string;
}

export interface DriveUserInfo {
  displayName?: string;
  emailAddress?: string;
  permissionId?: string;
}

export interface ParsedDocInput {
  fileId: string;
  sourceUrl: string;
  resourceKey?: string;
}

export interface LinkedFileContext {
  folderPath: string;
  folderName: string;
  manifestPath: string;
  key: string;
  matchedRelativePath: string;
  matchedOutputKind: LinkedFileMatchKind;
  entry: LinkedFileEntry;
}

export interface OAuthStateStore {
  load(): Promise<StoredOAuthState | undefined>;
  save(state: StoredOAuthState): Promise<void>;
  clear(): Promise<void>;
}

export interface SyncOutcome {
  status: "synced" | "skipped" | "cancelled";
  message: string;
  rebind?: {
    previousAccountId?: string;
    previousAccountEmail?: string;
    nextAccountId: string;
    nextAccountEmail?: string;
  };
  transition?: {
    kind: "spreadsheet-output-kind-changed";
    previousOutputKind: SyncOutputKind;
    nextOutputKind: SyncOutputKind;
    generatedDirectoryPath?: string;
  };
}

export interface GeneratedFileRecord {
  relativePath: string;
  contentHash?: string;
}

export interface GeneratedFilePayload {
  relativePath: string;
  bytes: Uint8Array;
  mimeType: string;
  contentHash: string;
}

export type GeneratedAssetRecord = GeneratedFileRecord;
export type GeneratedMarkdownAsset = GeneratedFilePayload;
