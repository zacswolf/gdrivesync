export interface LinkedFileEntry {
  docId: string;
  sourceUrl: string;
  resourceKey?: string;
  title: string;
  syncOnOpen: boolean;
  lastSyncedAt?: string;
  lastDriveVersion?: string;
  lastLocalHash?: string;
}

export interface SyncManifest {
  version: 1;
  files: Record<string, LinkedFileEntry>;
}

export interface GoogleReleaseConfig {
  desktopClientId: string;
  hostedBaseUrl: string;
  oauthBridgeUrl: string;
  pickerUrl: string;
  scope: string;
}

export interface StoredOAuthSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
  tokenType: string;
}

export interface OAuthStatePayload {
  nonce: string;
}

export interface PickerRequestPayload {
  nonce: string;
  localRedirect: string;
  hintDocId?: string;
  resourceKey?: string;
}

export interface PickerSelection {
  docId: string;
  title: string;
  sourceUrl: string;
  resourceKey?: string;
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

export interface ParsedDocInput {
  docId: string;
  sourceUrl: string;
  resourceKey?: string;
}

export interface LinkedFileContext {
  folderPath: string;
  folderName: string;
  manifestPath: string;
  key: string;
  entry: LinkedFileEntry;
}

export interface TokenStore {
  get(): Promise<StoredOAuthSession | undefined>;
  set(session: StoredOAuthSession): Promise<void>;
  delete(): Promise<void>;
}

export interface SyncOutcome {
  status: "synced" | "skipped" | "cancelled";
  message: string;
}
