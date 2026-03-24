import { access, mkdir, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileLockTimeoutError, readLockMetadata, withFileLock } from "../../src/utils/fileLock";

describe("withFileLock", () => {
  let rootPath: string;
  let targetPath: string;

  beforeEach(async () => {
    rootPath = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "gdrivesync-file-lock-")));
    targetPath = path.join(rootPath, ".gdrivesync.json");
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  it("acquires and releases the lock normally", async () => {
    await withFileLock(targetPath, "cli", async () => {
      await expect(access(`${targetPath}.lock`)).resolves.toBeUndefined();
      await expect(readLockMetadata(targetPath)).resolves.toMatchObject({
        owner: "cli",
        pid: process.pid
      });
    });

    await expect(access(`${targetPath}.lock`)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("waits for another writer to release the lock", async () => {
    let releaseFirstLock!: () => void;
    const firstLockReleased = new Promise<void>((resolve) => {
      releaseFirstLock = resolve;
    });
    let secondLockEntered = false;

    const firstTask = withFileLock(targetPath, "extension", async () => {
      await firstLockReleased;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondTask = withFileLock(
      targetPath,
      "cli",
      async () => {
        secondLockEntered = true;
      },
      {
        retryDelayMs: 10,
        acquireTimeoutMs: 500
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondLockEntered).toBe(false);

    releaseFirstLock();
    await firstTask;
    await secondTask;

    expect(secondLockEntered).toBe(true);
  });

  it("removes stale locks before acquiring a new one", async () => {
    const staleLockPath = `${targetPath}.lock`;
    await mkdir(staleLockPath);
    const staleDate = new Date(Date.now() - 120_000);
    await utimes(staleLockPath, staleDate, staleDate);

    await withFileLock(
      targetPath,
      "cli",
      async () => {
        const metadata = await readLockMetadata(targetPath);
        expect(metadata?.owner).toBe("cli");
      },
      {
        staleLockThresholdMs: 30_000
      }
    );

    await expect(access(staleLockPath)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("times out when a non-stale lock stays held", async () => {
    const lockPath = `${targetPath}.lock`;
    await mkdir(lockPath);

    await expect(
      withFileLock(
        targetPath,
        "cli",
        async () => undefined,
        {
          retryDelayMs: 10,
          acquireTimeoutMs: 60,
          staleLockThresholdMs: 10_000
        }
      )
    ).rejects.toBeInstanceOf(FileLockTimeoutError);

    const lockStats = await stat(lockPath);
    expect(lockStats.isDirectory()).toBe(true);
  });
});
