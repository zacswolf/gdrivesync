import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SecretStorage } from "vscode";

import { normalizeStoredOAuthSession } from "./sessionSchema";
import { CorruptStateError } from "./stateErrors";
import { StoredOAuthSession, TokenStore } from "./types";

const SECRET_STORAGE_KEY = "gdocSync.googleOAuthSession";

export class SecretStorageTokenStore implements TokenStore {
  constructor(private readonly secrets: SecretStorage) {}

  async get(): Promise<StoredOAuthSession | undefined> {
    const rawValue = await this.secrets.get(SECRET_STORAGE_KEY);
    if (!rawValue) {
      return undefined;
    }

    try {
      return normalizeStoredOAuthSession(JSON.parse(rawValue), "VS Code SecretStorage");
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new CorruptStateError(
          "oauth-session",
          "VS Code SecretStorage",
          "The saved GDriveSync Google session in VS Code SecretStorage is corrupted. Sign out and sign in again."
        );
      }

      throw error;
    }
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
      try {
        return normalizeStoredOAuthSession(JSON.parse(rawValue), this.filePath);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new CorruptStateError("oauth-session", this.filePath);
        }

        throw error;
      }
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
