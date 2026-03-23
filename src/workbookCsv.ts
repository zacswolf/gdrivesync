import path from "node:path";

import * as XLSX from "xlsx";

import { GeneratedFilePayload, SyncOutputKind } from "./types";
import { sha256Bytes } from "./utils/hash";
import { slugifyForFileName } from "./utils/paths";

interface WorkbookSheetState {
  name: string;
  Hidden?: number;
}

export interface WorkbookCsvOutput {
  outputKind: SyncOutputKind;
  visibleSheetCount: number;
  primaryFileText?: string;
  generatedFiles: GeneratedFilePayload[];
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function getVisibleSheetNames(workbook: XLSX.WorkBook): string[] {
  const hiddenByName = new Map<string, number>();
  const workbookState = workbook.Workbook as { Sheets?: WorkbookSheetState[] } | undefined;
  for (const sheetState of workbookState?.Sheets || []) {
    hiddenByName.set(sheetState.name, sheetState.Hidden ?? 0);
  }

  return workbook.SheetNames.filter((sheetName) => (hiddenByName.get(sheetName) ?? 0) === 0);
}

function buildUniqueSheetFileName(sheetName: string, usedNames: Set<string>): string {
  const baseName = slugifyForFileName(sheetName || "sheet");
  let candidate = `${baseName}.csv`;
  let index = 2;
  while (usedNames.has(candidate)) {
    candidate = `${baseName}-${index}.csv`;
    index += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

function toPayload(relativePath: string, text: string): GeneratedFilePayload {
  const bytes = Uint8Array.from(Buffer.from(text, "utf8"));
  return {
    relativePath,
    bytes,
    mimeType: "text/csv",
    contentHash: sha256Bytes(bytes)
  };
}

export function getSpreadsheetDirectoryName(baseTargetPath: string): string {
  return path.parse(baseTargetPath).name;
}

export function parseWorkbookToCsvOutput(baseTargetPath: string, workbookBytes: Uint8Array): WorkbookCsvOutput {
  const workbook = XLSX.read(Buffer.from(workbookBytes), {
    type: "buffer",
    cellFormula: false,
    raw: false
  });
  const visibleSheetNames = getVisibleSheetNames(workbook);
  if (visibleSheetNames.length === 0) {
    throw new Error("This spreadsheet has no visible worksheets to sync.");
  }

  if (visibleSheetNames.length === 1) {
    const worksheet = workbook.Sheets[visibleSheetNames[0]];
    if (!worksheet) {
      throw new Error("The selected spreadsheet worksheet could not be loaded.");
    }

    return {
      outputKind: "file",
      visibleSheetCount: visibleSheetNames.length,
      primaryFileText: XLSX.utils.sheet_to_csv(worksheet),
      generatedFiles: []
    };
  }

  const directoryName = getSpreadsheetDirectoryName(baseTargetPath);
  const usedNames = new Set<string>();
  const generatedFiles = visibleSheetNames.map((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      throw new Error(`Worksheet "${sheetName}" could not be loaded.`);
    }

    const fileName = buildUniqueSheetFileName(sheetName, usedNames);
    return toPayload(normalizeRelativePath(path.join(directoryName, fileName)), XLSX.utils.sheet_to_csv(worksheet));
  });

  return {
    outputKind: "directory",
    visibleSheetCount: visibleSheetNames.length,
    generatedFiles
  };
}
