import path from "node:path";

import { SyncOutputKind } from "../types";

interface SpreadsheetSyncSummaryInput {
  baseTargetPath: string;
  previousOutputKind: SyncOutputKind;
  nextOutputKind: SyncOutputKind;
  visibleSheetCount: number;
}

export function buildSpreadsheetSyncSummary(input: SpreadsheetSyncSummaryInput): string {
  const baseFileName = path.basename(input.baseTargetPath);
  const directoryName = `${path.parse(input.baseTargetPath).name}/`;

  if (input.previousOutputKind !== input.nextOutputKind) {
    if (input.nextOutputKind === "directory") {
      return `Synced ${baseFileName} and switched to folder output for ${input.visibleSheetCount} visible sheets in ${directoryName}`;
    }

    return `Synced ${baseFileName} and switched back to a single CSV.`;
  }

  if (input.nextOutputKind === "directory") {
    return `Synced ${input.visibleSheetCount} visible sheet CSVs in ${directoryName}`;
  }

  return `Synced ${baseFileName}.`;
}
