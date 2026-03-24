import { ParsedDocInput } from "../types";

const GOOGLE_DOC_ID_PATTERN = /^[a-zA-Z0-9_-]{20,}$/;

export function extractGoogleResourceKey(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }

  try {
    const url = new URL(input);
    return url.searchParams.get("resourcekey") || url.searchParams.get("resourceKey") || undefined;
  } catch {
    return undefined;
  }
}

export function parseGoogleDocInput(input: string): ParsedDocInput | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  if (GOOGLE_DOC_ID_PATTERN.test(trimmed)) {
    return {
      fileId: trimmed,
      sourceUrl: buildGoogleDriveFileUrl(trimmed)
    };
  }

  try {
    const url = new URL(trimmed);
    const idParam = url.searchParams.get("id");
    const match =
      url.pathname.match(/\/document\/d\/([a-zA-Z0-9_-]+)/) ||
      url.pathname.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/) ||
      url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/) ||
      url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) ||
      (idParam ? [idParam, idParam] : null);
    if (!match) {
      return undefined;
    }

    const resourceKey = extractGoogleResourceKey(trimmed);
    const fileId = match[1];
    return {
      fileId,
      sourceUrl: url.pathname.includes("/document/")
        ? buildGoogleDocUrl(fileId)
        : url.pathname.includes("/presentation/")
          ? buildGoogleSlidesUrl(fileId)
        : url.pathname.includes("/spreadsheets/")
          ? buildGoogleSheetUrl(fileId)
          : buildGoogleDriveFileUrl(fileId),
      resourceKey
    };
  } catch {
    return undefined;
  }
}

export function buildGoogleDocUrl(fileId: string): string {
  return `https://docs.google.com/document/d/${fileId}/edit`;
}

export function buildGoogleSheetUrl(fileId: string): string {
  return `https://docs.google.com/spreadsheets/d/${fileId}/edit`;
}

export function buildGoogleSlidesUrl(fileId: string): string {
  return `https://docs.google.com/presentation/d/${fileId}/edit`;
}

export function buildGoogleDriveFileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`;
}
