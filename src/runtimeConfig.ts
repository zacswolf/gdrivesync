import * as vscode from "vscode";

import { GoogleReleaseConfig } from "./types";

const DEFAULT_HOSTED_BASE_URL = "https://gdrivesync.zacswolf.com";
const DEFAULT_SCOPE = "https://www.googleapis.com/auth/drive.file";
const PLACEHOLDER_CLIENT_ID = "REPLACE_WITH_GOOGLE_DESKTOP_CLIENT_ID.apps.googleusercontent.com";

function normalizeBaseUrl(rawValue: string | undefined): string {
  const candidate = rawValue?.trim() || DEFAULT_HOSTED_BASE_URL;
  const url = new URL(candidate);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function buildConfig(desktopClientId: string, hostedBaseUrlOverride?: string): GoogleReleaseConfig {
  const hostedBaseUrl = normalizeBaseUrl(hostedBaseUrlOverride);
  return {
    desktopClientId: desktopClientId.trim() || PLACEHOLDER_CLIENT_ID,
    hostedBaseUrl,
    oauthBridgeUrl: `${hostedBaseUrl}/oauth/google/bridge`,
    pickerUrl: `${hostedBaseUrl}/picker`,
    scope: DEFAULT_SCOPE
  };
}

export function resolveExtensionGoogleConfig(): GoogleReleaseConfig {
  const config = vscode.workspace.getConfiguration("gdocSync");
  const desktopClientId =
    config.get<string>("development.desktopClientId") ||
    process.env.GDOCSYNC_DESKTOP_CLIENT_ID ||
    PLACEHOLDER_CLIENT_ID;
  const hostedBaseUrl =
    config.get<string>("development.hostedBaseUrl") ||
    process.env.GDOCSYNC_HOSTED_BASE_URL ||
    DEFAULT_HOSTED_BASE_URL;

  return buildConfig(desktopClientId, hostedBaseUrl);
}

export function resolveCliGoogleConfig(env: NodeJS.ProcessEnv = process.env): GoogleReleaseConfig {
  return buildConfig(env.GDOCSYNC_DESKTOP_CLIENT_ID || PLACEHOLDER_CLIENT_ID, env.GDOCSYNC_HOSTED_BASE_URL);
}

export function assertDesktopClientConfigured(config: GoogleReleaseConfig): void {
  if (!config.desktopClientId || config.desktopClientId === PLACEHOLDER_CLIENT_ID) {
    throw new Error(
      "Google desktop OAuth is not configured yet. Set gdocSync.development.desktopClientId for local development, or replace the placeholder release config before publishing."
    );
  }
}
