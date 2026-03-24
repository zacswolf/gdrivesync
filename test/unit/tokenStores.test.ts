import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileOAuthStateStore } from "../../src/tokenStores";

describe("FileOAuthStateStore", () => {
  let tempDirectory: string;
  let tokenPath: string;

  beforeEach(async () => {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "gdrivesync-token-store-"));
    tokenPath = path.join(tempDirectory, "oauth", "session.json");
  });

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });

  it("writes OAuth state atomically with restrictive permissions", async () => {
    const store = new FileOAuthStateStore(tokenPath);
    await store.save({
      version: 1,
      defaultAccountId: "perm-1",
      accounts: {
        "perm-1": {
          accountId: "perm-1",
          accountEmail: "me@example.com",
          session: {
            accessToken: "access-token",
            refreshToken: "refresh-token",
            expiresAt: Date.now() + 60_000,
            scope: "https://www.googleapis.com/auth/drive.readonly",
            tokenType: "Bearer"
          }
        }
      }
    });

    const fileStat = await stat(tokenPath);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const rawValue = await readFile(tokenPath, "utf8");
    expect(JSON.parse(rawValue)).toMatchObject({
      version: 1,
      defaultAccountId: "perm-1"
    });

    const siblings = await readdir(path.dirname(tokenPath));
    expect(siblings.filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});
