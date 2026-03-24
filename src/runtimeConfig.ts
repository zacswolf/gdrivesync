import { readFile } from "node:fs/promises";
import path from "node:path";

import { GoogleReleaseConfig } from "./types";

const DEFAULT_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DEFAULT_DESKTOP_CLIENT_ID = "532481685126-bjdbo5o6924bh41314la7s6ph4n02s62.apps.googleusercontent.com";

function parseDotEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function parseDotEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    values[key] = parseDotEnvValue(rawValue);
  }

  return values;
}

async function loadDotEnvFile(filePath: string, loadedKeys: Set<string>): Promise<void> {
  try {
    const contents = await readFile(filePath, "utf8");
    const parsed = parseDotEnvFile(contents);

    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined || loadedKeys.has(key)) {
        process.env[key] = value;
        loadedKeys.add(key);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function loadDevelopmentEnv(basePath: string): Promise<void> {
  const loadedKeys = new Set<string>();
  await loadDotEnvFile(path.join(basePath, ".env"), loadedKeys);
  await loadDotEnvFile(path.join(basePath, ".env.local"), loadedKeys);
}

export function shouldLoadCliDevelopmentEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GDRIVESYNC_LOAD_DEV_ENV === "1";
}

function normalizeBaseUrl(rawValue: string | undefined): string | undefined {
  const candidate = rawValue?.trim();
  if (!candidate) {
    return undefined;
  }
  const url = new URL(candidate);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

interface GoogleConfigValueOverrides {
  desktopClientId?: string;
  hostedBaseUrl?: string;
  desktopClientSecret?: string;
  loginHint?: string;
}

export function resolveGoogleConfigFromValues(overrides: GoogleConfigValueOverrides = {}): GoogleReleaseConfig {
  const desktopClientId = overrides.desktopClientId || process.env.GDRIVESYNC_DESKTOP_CLIENT_ID || DEFAULT_DESKTOP_CLIENT_ID;
  const hostedBaseUrlOverride = overrides.hostedBaseUrl || process.env.GDRIVESYNC_HOSTED_BASE_URL;
  const hostedBaseUrl = normalizeBaseUrl(hostedBaseUrlOverride);
  return {
    desktopClientId: desktopClientId.trim() || DEFAULT_DESKTOP_CLIENT_ID,
    desktopClientSecret: overrides.desktopClientSecret?.trim() || process.env.GDRIVESYNC_DESKTOP_CLIENT_SECRET || undefined,
    hostedBaseUrl,
    scope: DEFAULT_SCOPE,
    loginHint: overrides.loginHint?.trim() || process.env.GDRIVESYNC_LOGIN_HINT || undefined
  };
}

export function resolveCliGoogleConfig(env: NodeJS.ProcessEnv = process.env): GoogleReleaseConfig {
  return resolveGoogleConfigFromValues({
    desktopClientId: env.GDRIVESYNC_DESKTOP_CLIENT_ID || DEFAULT_DESKTOP_CLIENT_ID,
    hostedBaseUrl: env.GDRIVESYNC_HOSTED_BASE_URL,
    desktopClientSecret: env.GDRIVESYNC_DESKTOP_CLIENT_SECRET,
    loginHint: env.GDRIVESYNC_LOGIN_HINT
  });
}

export function assertDesktopClientConfigured(config: GoogleReleaseConfig): void {
  if (!config.desktopClientId.trim()) {
    throw new Error("Google desktop OAuth is not configured yet. Set gdocSync.development.desktopClientId.");
  }
}
