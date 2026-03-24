import { describe, expect, it, vi } from "vitest";

const vscodeMocks = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  setStatusBarMessage: vi.fn(),
  getConfiguration: vi.fn(() => ({
    get: vi.fn(),
    update: vi.fn()
  })),
  textDocuments: [] as unknown[]
}));

vi.mock("vscode", () => ({
  Uri: {
    file: (fsPath: string) => ({
      fsPath,
      toString: () => `file://${fsPath}`
    })
  },
  window: {
    showErrorMessage: vscodeMocks.showErrorMessage,
    setStatusBarMessage: vscodeMocks.setStatusBarMessage
  },
  workspace: {
    getConfiguration: vscodeMocks.getConfiguration,
    textDocuments: vscodeMocks.textDocuments
  },
  ConfigurationTarget: {
    Global: 1
  }
}));

describe("SyncManager", () => {
  it("clears pending sync-on-open timers when disposed", async () => {
    vi.useFakeTimers();
    try {
      const { SyncManager } = await import("../../src/syncManager");
      const manifestStore = {
        getLinkedFile: vi.fn()
      };
      const manager = new SyncManager(
        {} as never,
        {} as never,
        manifestStore as never,
        {} as never,
        {} as never
      );
      const syncFileSpy = vi.spyOn(manager, "syncFile");

      manager.scheduleSyncOnOpen({ fsPath: "/tmp/workspace/a.md", toString: () => "file:///tmp/workspace/a.md" } as never);
      manager.dispose();
      await vi.advanceTimersByTimeAsync(700);

      expect(manifestStore.getLinkedFile).not.toHaveBeenCalled();
      expect(syncFileSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule new sync-on-open work after disposal", async () => {
    vi.useFakeTimers();
    try {
      const { SyncManager } = await import("../../src/syncManager");
      const manifestStore = {
        getLinkedFile: vi.fn()
      };
      const manager = new SyncManager(
        {} as never,
        {} as never,
        manifestStore as never,
        {} as never,
        {} as never
      );
      const syncFileSpy = vi.spyOn(manager, "syncFile");

      manager.dispose();
      manager.scheduleSyncOnOpen({ fsPath: "/tmp/workspace/a.md", toString: () => "file:///tmp/workspace/a.md" } as never);
      await vi.advanceTimersByTimeAsync(700);

      expect(manifestStore.getLinkedFile).not.toHaveBeenCalled();
      expect(syncFileSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("syncs all linked files with bounded concurrency while preserving result order", async () => {
    vi.useFakeTimers();
    try {
      const { SyncManager } = await import("../../src/syncManager");
      const manager = new SyncManager(
        {} as never,
        {} as never,
        {
          listLinkedFiles: vi.fn(async () => [
            {
              fileUri: { fsPath: "/tmp/workspace/a.md" },
              context: { folderPath: "/tmp/workspace", key: "a.md" }
            },
            {
              fileUri: { fsPath: "/tmp/workspace/b.md" },
              context: { folderPath: "/tmp/workspace", key: "b.md" }
            },
            {
              fileUri: { fsPath: "/tmp/workspace/c.md" },
              context: { folderPath: "/tmp/workspace", key: "c.md" }
            },
            {
              fileUri: { fsPath: "/tmp/workspace/d.md" },
              context: { folderPath: "/tmp/workspace", key: "d.md" }
            },
            {
              fileUri: { fsPath: "/tmp/workspace/e.md" },
              context: { folderPath: "/tmp/workspace", key: "e.md" }
            }
          ])
        } as never,
        {} as never,
        {} as never
      );

      let activeCount = 0;
      let maxActiveCount = 0;
      const syncFileSpy = vi.spyOn(manager, "syncFile").mockImplementation(async (fileUri) => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 50));
        activeCount -= 1;
        return {
          status: "synced",
          message: `Synced ${String((fileUri as { fsPath?: string }).fsPath)}`
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
    } finally {
      vi.useRealTimers();
    }
  });
});
