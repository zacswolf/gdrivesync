import { describe, expect, it } from "vitest";

import { getSupportedSourceMimeTypes, getSyncProfile, resolveSyncProfileForMimeType } from "../../src/syncProfiles";

describe("syncProfiles", () => {
  it("lists the supported Google source mime types", () => {
    expect(getSupportedSourceMimeTypes()).toEqual([
      "application/vnd.google-apps.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.google-apps.presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ]);
  });

  it("resolves the Google Docs profile from mime type", () => {
    expect(resolveSyncProfileForMimeType("application/vnd.google-apps.document")?.id).toBe("google-doc-markdown");
  });

  it("uses a DOCX export path for native Google Docs", () => {
    const profile = getSyncProfile("google-doc-markdown");
    expect(profile.exportMimeType).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(profile.retrievalMode).toBe("drive-export-docx");
  });

  it("resolves the DOCX profile from mime type", () => {
    expect(resolveSyncProfileForMimeType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")?.id).toBe(
      "word-docx-markdown"
    );
  });

  it("resolves the Google Sheets profile from mime type", () => {
    expect(resolveSyncProfileForMimeType("application/vnd.google-apps.spreadsheet")?.id).toBe("google-sheet-csv");
  });

  it("resolves the Google Slides profile from mime type", () => {
    expect(resolveSyncProfileForMimeType("application/vnd.google-apps.presentation")?.id).toBe("google-slide-marp");
  });

  it("resolves the PowerPoint profile from mime type", () => {
    expect(resolveSyncProfileForMimeType("application/vnd.openxmlformats-officedocument.presentationml.presentation")?.id).toBe(
      "powerpoint-pptx-marp"
    );
  });

  it("resolves the XLSX profile from mime type", () => {
    expect(resolveSyncProfileForMimeType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")?.id).toBe(
      "excel-xlsx-csv"
    );
  });
});
