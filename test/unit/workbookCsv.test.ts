import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { parseWorkbookToCsvOutput } from "../../src/workbookCsv";

function buildWorkbookBuffer(
  sheets: Array<{ name: string; rows: unknown[][]; hidden?: number }>
): Uint8Array {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  }

  workbook.Workbook = {
    Sheets: sheets.map((sheet) => ({
      name: sheet.name,
      Hidden: sheet.hidden ?? 0
    }))
  };

  return Uint8Array.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

describe("parseWorkbookToCsvOutput", () => {
  it("returns a single CSV when there is one visible worksheet", () => {
    const output = parseWorkbookToCsvOutput(
      "/tmp/report.csv",
      buildWorkbookBuffer([{ name: "Summary", rows: [["Name", "Value"], ["A", 1]] }])
    );

    expect(output.outputKind).toBe("file");
    expect(output.primaryFileText).toContain("Name,Value");
    expect(output.generatedFiles).toEqual([]);
  });

  it("returns a folder of CSVs when there are multiple visible worksheets", () => {
    const output = parseWorkbookToCsvOutput(
      "/tmp/report.csv",
      buildWorkbookBuffer([
        { name: "Summary", rows: [["Name"], ["A"]] },
        { name: "Pipeline", rows: [["Lead"], ["B"]] }
      ])
    );

    expect(output.outputKind).toBe("directory");
    expect(output.generatedFiles.map((file) => file.relativePath)).toEqual(["report/summary.csv", "report/pipeline.csv"]);
  });

  it("ignores hidden worksheets when choosing the output shape", () => {
    const output = parseWorkbookToCsvOutput(
      "/tmp/report.csv",
      buildWorkbookBuffer([
        { name: "Visible", rows: [["Name"], ["A"]] },
        { name: "Hidden", rows: [["Secret"], ["B"]], hidden: 1 }
      ])
    );

    expect(output.outputKind).toBe("file");
    expect(output.primaryFileText).toContain("Name");
  });

  it("adds numeric suffixes when sheet filenames would collide", () => {
    const output = parseWorkbookToCsvOutput(
      "/tmp/report.csv",
      buildWorkbookBuffer([
        { name: "Q1 Revenue", rows: [["A"]] },
        { name: "Q1-Revenue", rows: [["B"]] }
      ])
    );

    expect(output.generatedFiles.map((file) => file.relativePath)).toEqual(["report/q1-revenue.csv", "report/q1-revenue-2.csv"]);
  });

  it("fails when there are no visible worksheets", () => {
    expect(() =>
      parseWorkbookToCsvOutput(
        "/tmp/report.csv",
        buildWorkbookBuffer([{ name: "Hidden", rows: [["A"]], hidden: 1 }])
      )
    ).toThrow("no visible worksheets");
  });
});
