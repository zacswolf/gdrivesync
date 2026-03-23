import { describe, expect, it } from "vitest";

import { getSupportedSourceMimeTypes, resolveSyncProfileForMimeType } from "../../src/syncProfiles";

describe("syncProfiles", () => {
  it("lists the supported Google source mime types", () => {
    expect(getSupportedSourceMimeTypes()).toEqual([
      "application/vnd.google-apps.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ]);
  });

  it("resolves the Google Docs profile from mime type", () => {
    expect(resolveSyncProfileForMimeType("application/vnd.google-apps.document")?.id).toBe("google-doc-markdown");
  });

  it("resolves the DOCX profile from mime type", () => {
    expect(resolveSyncProfileForMimeType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")?.id).toBe(
      "word-docx-markdown"
    );
  });

  it("resolves the Google Sheets profile from mime type", () => {
    expect(resolveSyncProfileForMimeType("application/vnd.google-apps.spreadsheet")?.id).toBe("google-sheet-csv");
  });

  it("resolves the XLSX profile from mime type", () => {
    expect(resolveSyncProfileForMimeType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")?.id).toBe(
      "excel-xlsx-csv"
    );
  });
});
