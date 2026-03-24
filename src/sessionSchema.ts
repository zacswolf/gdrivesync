import { CorruptStateError } from "./stateErrors";
import { ConnectedGoogleAccount, StoredOAuthSession, StoredOAuthState } from "./types";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function normalizeStoredOAuthSession(rawValue: unknown, stateLocation: string): StoredOAuthSession {
  if (!rawValue || typeof rawValue !== "object") {
    throw new CorruptStateError(
      "oauth-session",
      stateLocation,
      `The saved GDriveSync OAuth session at ${stateLocation} is malformed. Run gdrivesync doctor --repair or sign in again.`
    );
  }

  const candidate = rawValue as Record<string, unknown>;
  if (
    !isNonEmptyString(candidate.accessToken) ||
    !isFiniteNumber(candidate.expiresAt) ||
    !isNonEmptyString(candidate.scope) ||
    !isNonEmptyString(candidate.tokenType)
  ) {
    throw new CorruptStateError(
      "oauth-session",
      stateLocation,
      `The saved GDriveSync OAuth session at ${stateLocation} is missing required fields. Run gdrivesync doctor --repair or sign in again.`
    );
  }

  return {
    accessToken: candidate.accessToken,
    refreshToken: isNonEmptyString(candidate.refreshToken) ? candidate.refreshToken : undefined,
    expiresAt: candidate.expiresAt,
    scope: candidate.scope,
    tokenType: candidate.tokenType
  };
}

function normalizeConnectedAccount(rawValue: unknown, stateLocation: string): ConnectedGoogleAccount {
  if (!rawValue || typeof rawValue !== "object") {
    throw new CorruptStateError("oauth-session", stateLocation);
  }

  const candidate = rawValue as Record<string, unknown>;
  if (!isNonEmptyString(candidate.accountId)) {
    throw new CorruptStateError(
      "oauth-session",
      stateLocation,
      `The saved GDriveSync OAuth account record at ${stateLocation} is missing its account ID. Run gdrivesync doctor --repair or sign in again.`
    );
  }

  return {
    accountId: candidate.accountId,
    accountEmail: isNonEmptyString(candidate.accountEmail) ? candidate.accountEmail : undefined,
    accountDisplayName: isNonEmptyString(candidate.accountDisplayName) ? candidate.accountDisplayName : undefined,
    session: normalizeStoredOAuthSession(candidate.session, stateLocation)
  };
}

export function normalizeStoredOAuthState(rawValue: unknown, stateLocation: string): StoredOAuthState {
  if (!rawValue || typeof rawValue !== "object") {
    throw new CorruptStateError(
      "oauth-session",
      stateLocation,
      `The saved GDriveSync OAuth state at ${stateLocation} is malformed. Run gdrivesync doctor --repair or sign in again.`
    );
  }

  const candidate = rawValue as Record<string, unknown>;
  if (candidate.version !== 1) {
    throw new CorruptStateError(
      "oauth-session",
      stateLocation,
      `The saved GDriveSync OAuth state at ${stateLocation} uses unsupported schema version ${String(candidate.version)}.`
    );
  }

  const rawAccounts = candidate.accounts;
  if (!rawAccounts || typeof rawAccounts !== "object") {
    throw new CorruptStateError(
      "oauth-session",
      stateLocation,
      `The saved GDriveSync OAuth state at ${stateLocation} is missing account records. Run gdrivesync doctor --repair or sign in again.`
    );
  }

  const accounts: Record<string, ConnectedGoogleAccount> = {};
  for (const [accountId, rawAccount] of Object.entries(rawAccounts as Record<string, unknown>)) {
    const account = normalizeConnectedAccount(rawAccount, stateLocation);
    accounts[accountId] = {
      ...account,
      accountId
    };
  }

  const defaultAccountId = isNonEmptyString(candidate.defaultAccountId) ? candidate.defaultAccountId : undefined;
  if (defaultAccountId && !accounts[defaultAccountId]) {
    throw new CorruptStateError(
      "oauth-session",
      stateLocation,
      `The saved GDriveSync OAuth state at ${stateLocation} points at a missing default account. Run gdrivesync doctor --repair or sign in again.`
    );
  }

  return {
    version: 1,
    defaultAccountId,
    accounts
  };
}
