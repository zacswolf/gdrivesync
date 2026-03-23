import { ParsedDocInput } from "../types";

const GOOGLE_DOC_ID_PATTERN = /^[a-zA-Z0-9_-]{20,}$/;

export function parseGoogleDocInput(input: string): ParsedDocInput | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  if (GOOGLE_DOC_ID_PATTERN.test(trimmed)) {
    return {
      fileId: trimmed,
      sourceUrl: buildGoogleDocUrl(trimmed)
    };
  }

  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) {
      return undefined;
    }

    const resourceKey = url.searchParams.get("resourcekey") || url.searchParams.get("resourceKey") || undefined;
    const fileId = match[1];
    return {
      fileId,
      sourceUrl: buildGoogleDocUrl(fileId),
      resourceKey
    };
  } catch {
    return undefined;
  }
}

export function buildGoogleDocUrl(fileId: string): string {
  return `https://docs.google.com/document/d/${fileId}/edit`;
}
