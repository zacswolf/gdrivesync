export function buildCliSyncAllSummary(summary: {
  syncedCount: number;
  skippedCount: number;
  cancelledCount: number;
  failedCount: number;
}): string {
  const parts: string[] = [];
  if (summary.syncedCount > 0) {
    parts.push(`${summary.syncedCount} synced`);
  }
  if (summary.skippedCount > 0) {
    parts.push(`${summary.skippedCount} already up to date`);
  }
  if (summary.cancelledCount > 0) {
    parts.push(`${summary.cancelledCount} cancelled`);
  }
  if (summary.failedCount > 0) {
    parts.push(`${summary.failedCount} failed`);
  }

  return parts.length > 0 ? parts.join(", ") : "No linked files were processed.";
}
