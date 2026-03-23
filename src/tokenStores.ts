import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SecretStorage } from "vscode";

import { StoredOAuthSession, TokenStore } from "./types";

const SECRET_STORAGE_KEY = "gdocSync.googleOAuthSession";

export class SecretStorageTokenStore implements TokenStore {
  constructor(private readonly secrets: SecretStorage) {}

  async get(): Promise<StoredOAuthSession | undefined> {
    const rawValue = await this.secrets.get(SECRET_STORAGE_KEY);
    return rawValue ? (JSON.parse(rawValue) as StoredOAuthSession) : undefined;
  }

  async set(session: StoredOAuthSession): Promise<void> {
    await this.secrets.store(SECRET_STORAGE_KEY, JSON.stringify(session));
  }

  async delete(): Promise<void> {
    await this.secrets.delete(SECRET_STORAGE_KEY);
  }
}

export class FileTokenStore implements TokenStore {
  constructor(private readonly filePath: string) {}

  async get(): Promise<StoredOAuthSession | undefined> {
    try {
      const rawValue = await readFile(this.filePath, "utf8");
      return JSON.parse(rawValue) as StoredOAuthSession;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  async set(session: StoredOAuthSession): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  }

  async delete(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
