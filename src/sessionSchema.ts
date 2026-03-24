import { CorruptStateError } from "./stateErrors";
import { StoredOAuthSession } from "./types";

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
