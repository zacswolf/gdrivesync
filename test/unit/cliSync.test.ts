import { describe, expect, it, vi } from "vitest";

import { CliSyncManager } from "../../src/cliSync";

function createLinkedFile(filePath: string) {
  return {
    filePath,
    context: {
      folderPath: "/tmp/workspace",
      key: filePath.replace("/tmp/workspace/", ""),
      entry: {}
    }
  };
}

describe("CliSyncManager", () => {
  it("syncs all linked files with bounded concurrency while preserving result order", async () => {
    vi.useFakeTimers();
    try {
      const manager = new CliSyncManager(
        {} as never,
        {} as never,
        {
          listLinkedFiles: vi.fn(async () => [
            createLinkedFile("/tmp/workspace/a.md"),
            createLinkedFile("/tmp/workspace/b.md"),
            createLinkedFile("/tmp/workspace/c.md"),
            createLinkedFile("/tmp/workspace/d.md"),
            createLinkedFile("/tmp/workspace/e.md")
          ])
        } as never,
        {} as never,
        {} as never
      );

      let activeCount = 0;
      let maxActiveCount = 0;
      const syncFileSpy = vi.spyOn(manager, "syncFile").mockImplementation(async (filePath) => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 50));
        activeCount -= 1;
        if (String(filePath).endsWith("c.md")) {
          throw new Error("boom");
        }
        return {
          status: "synced",
          message: `Synced ${filePath}`
        };
      });

      const summaryPromise = manager.syncAll();

      await vi.advanceTimersByTimeAsync(0);
      expect(syncFileSpy).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(50);
      expect(syncFileSpy).toHaveBeenCalledTimes(5);

      await vi.advanceTimersByTimeAsync(50);
      const summary = await summaryPromise;

      expect(maxActiveCount).toBe(3);
      expect(summary.results.map((result) => result.file)).toEqual([
        "/tmp/workspace/a.md",
        "/tmp/workspace/b.md",
        "/tmp/workspace/c.md",
        "/tmp/workspace/d.md",
        "/tmp/workspace/e.md"
      ]);
      expect(summary.failedCount).toBe(1);
      expect(summary.results[2].outcome).toMatchObject({
        status: "failed",
        message: "boom"
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
