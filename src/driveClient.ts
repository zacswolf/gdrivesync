import { buildGoogleDocUrl } from "./utils/docUrl";
import { DriveFileMetadata } from "./types";

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

export class DriveClient {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async getFileMetadata(accessToken: string, docId: string, resourceKey?: string): Promise<DriveFileMetadata> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}`);
    url.searchParams.set("fields", "id,name,mimeType,version,modifiedTime,resourceKey,webViewLink");
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
      await this.throwDriveError(response, docId);
    }

    const payload = (await response.json()) as DriveFileMetadata;
    if (payload.mimeType !== "application/vnd.google-apps.document") {
      throw new GoogleApiError("The selected file is not a Google Doc.", 400, payload.mimeType);
    }

    payload.webViewLink = payload.webViewLink || buildGoogleDocUrl(payload.id);
    return payload;
  }

  async exportMarkdown(accessToken: string, docId: string, resourceKey?: string): Promise<string> {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}/export`);
    url.searchParams.set("mimeType", "text/markdown");
    if (resourceKey) {
      url.searchParams.set("resourceKey", resourceKey);
    }

    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      await this.throwDriveError(response, docId);
    }

    return response.text();
  }

  private async throwDriveError(response: Response, docId: string): Promise<never> {
    const details = await response.text();
    if (response.status === 403 || response.status === 404) {
      throw new PickerGrantRequiredError(
        `The current Google session cannot access Doc ${docId}. Open the Doc through Google Picker to grant access.`,
        response.status,
        details
      );
    }

    throw new GoogleApiError(`Google Drive request failed with status ${response.status}.`, response.status, details);
  }
}
