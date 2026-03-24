import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { SecretStorage } from "vscode";

import { normalizeStoredOAuthSession, normalizeStoredOAuthState } from "./sessionSchema";
import { CorruptStateError } from "./stateErrors";
import { ConnectedGoogleAccount, OAuthStateStore, StoredOAuthState } from "./types";
import { writeFileAtomically } from "./utils/atomicWrite";

const SECRET_STORAGE_INDEX_KEY = "gdocSync.googleOAuthAccounts";
const SECRET_STORAGE_SESSION_KEY_PREFIX = "gdocSync.googleOAuthAccount.";

interface StoredOAuthSecretIndex {
  version: 1;
  defaultAccountId?: string;
  accounts: Record<
    string,
    {
      accountId: string;
      accountEmail?: string;
      accountDisplayName?: string;
    }
  >;
}

function buildSessionSecretKey(accountId: string): string {
  return `${SECRET_STORAGE_SESSION_KEY_PREFIX}${accountId}`;
}

function sortAccounts(accounts: Record<string, ConnectedGoogleAccount>): Record<string, ConnectedGoogleAccount> {
  return Object.fromEntries(Object.entries(accounts).sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeState(state: StoredOAuthState): StoredOAuthState {
  const sortedAccounts = sortAccounts(state.accounts);
  const defaultAccountId = state.defaultAccountId && sortedAccounts[state.defaultAccountId]
    ? state.defaultAccountId
    : Object.keys(sortedAccounts)[0];

  return {
    version: 1,
    defaultAccountId,
    accounts: sortedAccounts
  };
}

function buildSecretIndex(state: StoredOAuthState): StoredOAuthSecretIndex {
  const normalized = normalizeState(state);
  return {
    version: 1,
    defaultAccountId: normalized.defaultAccountId,
    accounts: Object.fromEntries(
      Object.entries(normalized.accounts).map(([accountId, account]) => [
        accountId,
        {
          accountId,
          accountEmail: account.accountEmail,
          accountDisplayName: account.accountDisplayName
        }
      ])
    )
  };
}

function normalizeSecretIndex(rawValue: unknown, stateLocation: string): StoredOAuthSecretIndex {
  if (!rawValue || typeof rawValue !== "object") {
    throw new CorruptStateError("oauth-session", stateLocation);
  }

  const candidate = rawValue as Record<string, unknown>;
  if (candidate.version !== 1) {
    throw new CorruptStateError(
      "oauth-session",
      stateLocation,
      `The saved GDriveSync Google account index at ${stateLocation} uses unsupported schema version ${String(candidate.version)}.`
    );
  }

  const rawAccounts = candidate.accounts;
  if (!rawAccounts || typeof rawAccounts !== "object") {
    throw new CorruptStateError("oauth-session", stateLocation);
  }

  const accounts: StoredOAuthSecretIndex["accounts"] = {};
  for (const [accountId, rawAccount] of Object.entries(rawAccounts as Record<string, unknown>)) {
    if (!rawAccount || typeof rawAccount !== "object") {
      continue;
    }
    const entry = rawAccount as Record<string, unknown>;
    accounts[accountId] = {
      accountId,
      accountEmail: typeof entry.accountEmail === "string" ? entry.accountEmail : undefined,
      accountDisplayName: typeof entry.accountDisplayName === "string" ? entry.accountDisplayName : undefined
    };
  }

  const defaultAccountId =
    typeof candidate.defaultAccountId === "string" && accounts[candidate.defaultAccountId]
      ? candidate.defaultAccountId
      : Object.keys(accounts)[0];

  return {
    version: 1,
    defaultAccountId,
    accounts
  };
}

export class SecretStorageOAuthStateStore implements OAuthStateStore {
  constructor(private readonly secrets: SecretStorage) {}

  async load(): Promise<StoredOAuthState | undefined> {
    const rawIndex = await this.secrets.get(SECRET_STORAGE_INDEX_KEY);
    if (!rawIndex) {
      return undefined;
    }

    let index: StoredOAuthSecretIndex;
    try {
      index = normalizeSecretIndex(JSON.parse(rawIndex), "VS Code SecretStorage");
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new CorruptStateError(
          "oauth-session",
          "VS Code SecretStorage",
          "The saved GDriveSync Google account index in VS Code SecretStorage is corrupted. Disconnect Google Account and connect it again."
        );
      }

      throw error;
    }

    const accounts: StoredOAuthState["accounts"] = {};
    for (const [accountId, account] of Object.entries(index.accounts)) {
      const rawSession = await this.secrets.get(buildSessionSecretKey(accountId));
      if (!rawSession) {
        continue;
      }

      try {
        accounts[accountId] = {
          ...account,
          session: normalizeStoredOAuthSession(JSON.parse(rawSession), `VS Code SecretStorage (${accountId})`)
        };
      } catch {
        continue;
      }
    }

    if (Object.keys(accounts).length === 0) {
      return undefined;
    }

    return normalizeState({
      version: 1,
      defaultAccountId: index.defaultAccountId,
      accounts
    });
  }

  async save(state: StoredOAuthState): Promise<void> {
    const normalized = normalizeState(state);
    const nextAccountIds = new Set(Object.keys(normalized.accounts));
    const existing = await this.load().catch(() => undefined);
    const existingAccountIds = new Set(Object.keys(existing?.accounts || {}));

    for (const accountId of nextAccountIds) {
      await this.secrets.store(
        buildSessionSecretKey(accountId),
        JSON.stringify(normalized.accounts[accountId].session)
      );
    }

    for (const accountId of existingAccountIds) {
      if (!nextAccountIds.has(accountId)) {
        await this.secrets.delete(buildSessionSecretKey(accountId));
      }
    }

    await this.secrets.store(SECRET_STORAGE_INDEX_KEY, JSON.stringify(buildSecretIndex(normalized)));
  }

  async clear(): Promise<void> {
    const existing = await this.load().catch(() => undefined);
    for (const accountId of Object.keys(existing?.accounts || {})) {
      await this.secrets.delete(buildSessionSecretKey(accountId));
    }
    await this.secrets.delete(SECRET_STORAGE_INDEX_KEY);
  }
}

export class FileOAuthStateStore implements OAuthStateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<StoredOAuthState | undefined> {
    try {
      const rawValue = await readFile(this.filePath, "utf8");
      try {
        return normalizeStoredOAuthState(JSON.parse(rawValue), this.filePath);
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

  async save(state: StoredOAuthState): Promise<void> {
    await writeFileAtomically(this.filePath, `${JSON.stringify(normalizeState(state), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
