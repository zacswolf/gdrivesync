import { DriveFileMetadata, DriveUserInfo } from "./types";
import { RequestTimeoutError, fetchWithTimeout } from "./utils/fetchTimeout";

type FetchLike = typeof fetch;
const DEFAULT_GOOGLE_API_TIMEOUT_MS = 30_000;
const DEFAULT_GOOGLE_API_RETRY_DELAYS_MS = [250, 750] as const;

type SleepLike = (durationMs: number) => Promise<void>;

interface ParsedDriveErrorDetails {
  message?: string;
  reason?: string;
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: string,
    readonly reason?: string
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
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly requestTimeoutMs = DEFAULT_GOOGLE_API_TIMEOUT_MS,
    private readonly retryDelaysMs: readonly number[] = DEFAULT_GOOGLE_API_RETRY_DELAYS_MS,
    private readonly sleep: SleepLike = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs))
  ) {}

  private shouldRetryStatus(status: number): boolean {
    return status === 429 || status === 500 || status === 502 || status === 503;
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetchWithTimeout(
          this.fetchImpl,
          url,
          init,
          this.requestTimeoutMs,
          "Google Drive request timed out."
        );
        if (!this.shouldRetryStatus(response.status) || attempt >= this.retryDelaysMs.length) {
          return response;
        }

        void response.body?.cancel().catch(() => undefined);
        await this.sleep(this.retryDelaysMs[attempt]);
      } catch (error) {
        if (error instanceof RequestTimeoutError) {
          throw new GoogleApiError(error.message, 408);
        }
        throw error;
      }
    }
  }

  async getCurrentUser(accessToken: string): Promise<DriveUserInfo | undefined> {
    const url = new URL("https://www.googleapis.com/drive/v3/about");
    url.searchParams.set("fields", "user(displayName,emailAddress,permissionId)");

    const response = await this.send(url, {
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

    const response = await this.send(url, {
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

    const response = await this.send(url, {
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

    const response = await this.send(url, {
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      await this.throwDriveError(response, fileId);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  private parseDriveErrorDetails(details: string): ParsedDriveErrorDetails {
    try {
      const payload = JSON.parse(details) as {
        error?: {
          message?: string;
          errors?: Array<{ reason?: string }>;
        };
      };
      return {
        message: payload.error?.message,
        reason: payload.error?.errors?.[0]?.reason
      };
    } catch {
      return {};
    }
  }

  private async throwDriveError(response: Response, fileId: string): Promise<never> {
    const details = await response.text();
    const parsedDetails = this.parseDriveErrorDetails(details);
    if (parsedDetails.reason === "exportSizeLimitExceeded") {
      throw new GoogleApiError(
        parsedDetails.message || "This Google Workspace file is too large to export.",
        response.status,
        details,
        parsedDetails.reason
      );
    }

    if (response.status === 403 || response.status === 404) {
      throw new PickerGrantRequiredError(
        parsedDetails.message
          ? `${parsedDetails.message} (file ${fileId})`
          : `The current Google session cannot access Google file ${fileId}. Share it with this account or sign in with a Google account that can read it.`,
        response.status,
        details,
        parsedDetails.reason
      );
    }

    throw new GoogleApiError(
      parsedDetails.message || `Google Drive request failed with status ${response.status}.`,
      response.status,
      details,
      parsedDetails.reason
    );
  }
}
