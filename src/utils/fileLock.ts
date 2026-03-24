import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type FileLockOwner = "extension" | "cli";

export interface FileLockOptions {
  retryDelayMs?: number;
  acquireTimeoutMs?: number;
  staleLockThresholdMs?: number;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
}

interface LockMetadata {
  pid: number;
  createdAt: string;
  owner: FileLockOwner;
}

const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_THRESHOLD_MS = 30_000;
const LOCK_METADATA_FILE_NAME = "metadata.json";

export class FileLockTimeoutError extends Error {
  readonly name = "FileLockTimeoutError";

  constructor(
    readonly targetPath: string,
    readonly lockPath: string
  ) {
    super(`Timed out waiting for the lock at ${lockPath}.`);
  }
}

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function getLockPath(targetPath: string): string {
  return `${targetPath}.lock`;
}

async function writeLockMetadata(lockPath: string, owner: FileLockOwner, createdAtMs: number): Promise<void> {
  const metadata: LockMetadata = {
    pid: process.pid,
    createdAt: new Date(createdAtMs).toISOString(),
    owner
  };

  await writeFile(path.join(lockPath, LOCK_METADATA_FILE_NAME), `${JSON.stringify(metadata, null, 2)}\n`, "utf8").catch(() => undefined);
}

async function isLockStale(lockPath: string, now: () => number, staleLockThresholdMs: number): Promise<boolean> {
  try {
    const lockStats = await stat(lockPath);
    return now() - lockStats.mtimeMs > staleLockThresholdMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await rm(path.join(lockPath, LOCK_METADATA_FILE_NAME), { force: true }).catch(() => undefined);
  await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
}

export async function readLockMetadata(targetPath: string): Promise<LockMetadata | undefined> {
  const lockPath = getLockPath(targetPath);
  try {
    const rawValue = await readFile(path.join(lockPath, LOCK_METADATA_FILE_NAME), "utf8");
    return JSON.parse(rawValue) as LockMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export async function withFileLock<T>(
  targetPath: string,
  owner: FileLockOwner,
  task: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const staleLockThresholdMs = options.staleLockThresholdMs ?? DEFAULT_STALE_LOCK_THRESHOLD_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const lockPath = getLockPath(targetPath);
  const startedAt = now();

  while (true) {
    try {
      await mkdir(lockPath);
      await writeLockMetadata(lockPath, owner, now());
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      if (await isLockStale(lockPath, now, staleLockThresholdMs)) {
        await releaseLock(lockPath);
        continue;
      }

      if (now() - startedAt >= acquireTimeoutMs) {
        throw new FileLockTimeoutError(targetPath, lockPath);
      }

      await sleep(retryDelayMs);
    }
  }

  try {
    return await task();
  } finally {
    await releaseLock(lockPath);
  }
}
