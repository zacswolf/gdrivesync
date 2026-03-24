import { DriveFileMetadata, DriveUserInfo } from "./types";

type FetchLike = typeof fetch;

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: string
  ) {
    super(message);
  }
}

export class PickerGrantRequiredError extends GoogleApiError {}

interface FileMetadataRequest {
  fileId: string;
  resourceKey?: string;
  expectedMimeTypes?: string[];
  sourceTypeLabel?: string;
}

export class DriveClient {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async getCurrentUser(accessToken: string): Promise<DriveUserInfo | undefined> {
    const url = new URL("https://www.googleapis.com/drive/v3/about");
    url.searchParams.set("fields", "user(displayName,emailAddress)");

    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as { user?: DriveUserInfo };
    return payload.user;
  }

  async getFileMetadata(accessToken: string, request: FileMetadataRequest): Promise<DriveFileMetadata> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(request.fileId)}`);
    url.searchParams.set("fields", "id,name,mimeType,version,modifiedTime,resourceKey,webViewLink");
    url.searchParams.set("supportsAllDrives", "true");
    if (request.resourceKey) {
      url.searchParams.set("resourceKey", request.resourceKey);
    }

    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      await this.throwDriveError(response, request.fileId);
    }

    const payload = (await response.json()) as DriveFileMetadata;
    if (request.expectedMimeTypes && !request.expectedMimeTypes.includes(payload.mimeType)) {
      throw new GoogleApiError(`The selected file is not a ${request.sourceTypeLabel || "supported Google file"}.`, 400, payload.mimeType);
    }

    return payload;
  }

  async exportText(accessToken: string, fileId: string, exportMimeType: string, resourceKey?: string): Promise<string> {
    const bytes = await this.exportFile(accessToken, fileId, exportMimeType, resourceKey);
    return Buffer.from(bytes).toString("utf8");
  }

  async exportFile(accessToken: string, fileId: string, exportMimeType: string, resourceKey?: string): Promise<Uint8Array> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export`);
    url.searchParams.set("mimeType", exportMimeType);
    if (resourceKey) {
      url.searchParams.set("resourceKey", resourceKey);
    }

    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      await this.throwDriveError(response, fileId);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  async downloadFile(accessToken: string, fileId: string, resourceKey?: string): Promise<Uint8Array> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
    if (resourceKey) {
      url.searchParams.set("resourceKey", resourceKey);
    }

    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      await this.throwDriveError(response, fileId);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  private async throwDriveError(response: Response, fileId: string): Promise<never> {
    const details = await response.text();
    if (response.status === 403 || response.status === 404) {
      throw new PickerGrantRequiredError(
        `The current Google session cannot access Google file ${fileId}. Share it with this account or sign in with a Google account that can read it.`,
        response.status,
        details
      );
    }

    throw new GoogleApiError(`Google Drive request failed with status ${response.status}.`, response.status, details);
  }
}
