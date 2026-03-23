import { describe, expect, it } from "vitest";

import { buildCliSyncAllSummary } from "../../src/utils/cliSyncSummary";

describe("buildCliSyncAllSummary", () => {
  it("includes failed counts in the summary", () => {
    expect(
      buildCliSyncAllSummary({
        syncedCount: 2,
        skippedCount: 1,
        cancelledCount: 0,
        failedCount: 3
      })
    ).toBe("2 synced, 1 already up to date, 3 failed");
  });

  it("falls back to a default message when nothing was processed", () => {
    expect(
      buildCliSyncAllSummary({
        syncedCount: 0,
        skippedCount: 0,
        cancelledCount: 0,
        failedCount: 0
      })
    ).toBe("No linked files were processed.");
  });
});
