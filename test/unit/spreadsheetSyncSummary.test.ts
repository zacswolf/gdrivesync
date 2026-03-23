import { describe, expect, it } from "vitest";

import { buildSpreadsheetSyncSummary } from "../../src/utils/spreadsheetSyncSummary";

describe("buildSpreadsheetSyncSummary", () => {
  it("describes a file-to-directory transition", () => {
    expect(
      buildSpreadsheetSyncSummary({
        baseTargetPath: "/tmp/report.csv",
        previousOutputKind: "file",
        nextOutputKind: "directory",
        visibleSheetCount: 3
      })
    ).toBe("Synced report.csv and switched to folder output for 3 visible sheets in report/");
  });

  it("describes a directory-to-file transition", () => {
    expect(
      buildSpreadsheetSyncSummary({
        baseTargetPath: "/tmp/report.csv",
        previousOutputKind: "directory",
        nextOutputKind: "file",
        visibleSheetCount: 1
      })
    ).toBe("Synced report.csv and switched back to a single CSV.");
  });

  it("describes a steady directory sync", () => {
    expect(
      buildSpreadsheetSyncSummary({
        baseTargetPath: "/tmp/report.csv",
        previousOutputKind: "directory",
        nextOutputKind: "directory",
        visibleSheetCount: 4
      })
    ).toBe("Synced 4 visible sheet CSVs in report/");
  });

  it("describes a steady file sync", () => {
    expect(
      buildSpreadsheetSyncSummary({
        baseTargetPath: "/tmp/report.csv",
        previousOutputKind: "file",
        nextOutputKind: "file",
        visibleSheetCount: 1
      })
    ).toBe("Synced report.csv.");
  });
});
