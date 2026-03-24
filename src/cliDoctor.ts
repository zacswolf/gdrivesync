import { mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

import { CliManifestStore } from "./cliManifestStore";
import { DriveClient } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { inspectManifestValue, parseManifestText } from "./manifestSchema";
import { resolveCliGoogleConfig } from "./runtimeConfig";
import { normalizeStoredOAuthSession } from "./sessionSchema";
import { CorruptStateError } from "./stateErrors";
import { StoredOAuthSession } from "./types";
import { fromManifestKey } from "./utils/paths";
import { hasRequiredScopes } from "./utils/oauthScopes";

export interface DoctorIssue {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  path?: string;
}

export interface CliDoctorReport {
  rootPath: string;
  manifest: {
    path: string;
    exists: boolean;
    valid: boolean;
    linkedFileCount: number;
    droppedInvalidEntryCount: number;
    missingPrimaryFileCount: number;
    missingGeneratedFileCount: number;
    backupPath?: string;
  };
  auth: {
    tokenPath: string;
    sessionFileExists: boolean;
    authenticated: boolean;
    sessionValid: boolean;
    refreshTokenPresent: boolean;
    scopeMatchesConfig: boolean;
    scope?: string;
    expiresAt?: string;
    expiresInSeconds?: number;
    currentUserEmail?: string;
    backupPath?: string;
  };
  config: {
    desktopClientConfigured: boolean;
    hostedBaseUrl: string;
    scope: string;
  };
  issues: DoctorIssue[];
  repair: {
    attempted: boolean;
    performed: boolean;
    actions: string[];
  };
}

interface CliDoctorOptions {
  repair?: boolean;
}

function buildBackupPath(filePath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${filePath}.corrupt-${timestamp}`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function backupFile(targetPath: string): Promise<string> {
  const backupPath = buildBackupPath(targetPath);
  await mkdir(path.dirname(backupPath), { recursive: true });
  await rename(targetPath, backupPath);
  return backupPath;
}

export async function inspectCliAuthState(
  tokenPath: string,
  authManager: GoogleAuthManager,
  driveClient: DriveClient
): Promise<{ auth: CliDoctorReport["auth"]; issues: DoctorIssue[] }> {
  const issues: DoctorIssue[] = [];
  const config = resolveCliGoogleConfig();
  const sessionFileExists = await pathExists(tokenPath);
  const auth: CliDoctorReport["auth"] = {
    tokenPath,
    sessionFileExists,
    authenticated: false,
    sessionValid: false,
    refreshTokenPresent: false,
    scopeMatchesConfig: false
  };

  if (!sessionFileExists) {
    issues.push({
      severity: "info",
      code: "AUTH_NOT_SIGNED_IN",
      message: "No saved CLI Google session was found. Run gdrivesync auth login when you need Drive access.",
      path: tokenPath
    });
    return { auth, issues };
  }

  const rawSession = await readFile(tokenPath, "utf8");
  let parsedSession: StoredOAuthSession;
  try {
    parsedSession = normalizeStoredOAuthSession(JSON.parse(rawSession), tokenPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CorruptStateError("oauth-session", tokenPath);
    }

    throw error;
  }
  auth.authenticated = true;
  auth.sessionValid = true;
  auth.refreshTokenPresent = Boolean(parsedSession.refreshToken);
  auth.scope = parsedSession.scope;
  auth.scopeMatchesConfig = hasRequiredScopes(parsedSession.scope, config.scope);
  auth.expiresAt = new Date(parsedSession.expiresAt).toISOString();
  auth.expiresInSeconds = Math.max(0, Math.floor((parsedSession.expiresAt - Date.now()) / 1000));

  if (!auth.scopeMatchesConfig) {
    issues.push({
      severity: "warning",
      code: "AUTH_SCOPE_MISMATCH",
      message: "The saved CLI Google session is missing the current required Drive read-only scope. Sign in again to refresh it.",
      path: tokenPath
    });
  }

  try {
    const accessToken = await authManager.getAccessToken();
    const currentUser = await driveClient.getCurrentUser(accessToken);
    auth.currentUserEmail = currentUser?.emailAddress;
  } catch (error) {
    issues.push({
      severity: "warning",
      code: "AUTH_VALIDATION_FAILED",
      message: error instanceof Error ? error.message : "The saved CLI Google session could not be validated.",
      path: tokenPath
    });
  }

  return { auth, issues };
}

export async function runCliDoctor(
  rootPath: string,
  tokenPath: string,
  manifestStore: CliManifestStore,
  authManager: GoogleAuthManager,
  driveClient: DriveClient,
  options: CliDoctorOptions = {}
): Promise<CliDoctorReport> {
  const config = resolveCliGoogleConfig();
  const issues: DoctorIssue[] = [];
  const actions: string[] = [];
  let repairPerformed = false;

  const report: CliDoctorReport = {
    rootPath,
    manifest: {
      path: manifestStore.getManifestPath(),
      exists: false,
      valid: true,
      linkedFileCount: 0,
      droppedInvalidEntryCount: 0,
      missingPrimaryFileCount: 0,
      missingGeneratedFileCount: 0
    },
    auth: {
      tokenPath,
      sessionFileExists: false,
      authenticated: false,
      sessionValid: false,
      refreshTokenPresent: false,
      scopeMatchesConfig: false
    },
    config: {
      desktopClientConfigured: config.desktopClientId.trim().length > 0,
      hostedBaseUrl: config.hostedBaseUrl,
      scope: config.scope
    },
    issues,
    repair: {
      attempted: Boolean(options.repair),
      performed: false,
      actions
    }
  };

  if (!report.config.desktopClientConfigured) {
    issues.push({
      severity: "error",
      code: "CONFIG_MISSING_DESKTOP_CLIENT_ID",
      message: "The CLI Google desktop OAuth client ID is not configured."
    });
  }

  const manifestPath = manifestStore.getManifestPath();
  report.manifest.exists = await pathExists(manifestPath);
  if (!report.manifest.exists) {
    issues.push({
      severity: "info",
      code: "MANIFEST_NOT_FOUND",
      message: "No manifest exists in this workspace yet. That is normal until you link a file.",
      path: manifestPath
    });
  } else {
    try {
      const rawManifest = await readFile(manifestPath, "utf8");
      const inspection = parseManifestText(rawManifest, manifestPath);
      report.manifest.valid = true;
      report.manifest.linkedFileCount = inspection.normalizedEntryCount;
      report.manifest.droppedInvalidEntryCount = inspection.droppedEntryCount;

      if (inspection.droppedEntryCount > 0) {
        issues.push({
          severity: "warning",
          code: "MANIFEST_DROPPED_INVALID_ENTRIES",
          message: `${inspection.droppedEntryCount} invalid manifest entr${inspection.droppedEntryCount === 1 ? "y was" : "ies were"} ignored.`,
          path: manifestPath
        });

        if (options.repair) {
          const backupPath = await backupFile(manifestPath);
          await manifestStore.writeManifest(inspection.manifest);
          report.manifest.backupPath = backupPath;
          actions.push(`Backed up the manifest to ${backupPath} and rewrote a normalized manifest.`);
          repairPerformed = true;
        }
      }

      for (const [key, entry] of Object.entries(inspection.manifest.files)) {
        const primaryPath = fromManifestKey(rootPath, key);
        if (!(await pathExists(primaryPath))) {
          report.manifest.missingPrimaryFileCount += 1;
        }

        for (const generatedFile of entry.generatedFiles || []) {
          const generatedPath = path.join(rootPath, ...generatedFile.relativePath.split("/"));
          if (!(await pathExists(generatedPath))) {
            report.manifest.missingGeneratedFileCount += 1;
          }
        }
      }

      if (report.manifest.missingPrimaryFileCount > 0) {
        issues.push({
          severity: "warning",
          code: "MANIFEST_MISSING_PRIMARY_OUTPUTS",
          message: `${report.manifest.missingPrimaryFileCount} linked local output file${report.manifest.missingPrimaryFileCount === 1 ? " is" : "s are"} missing and would be recreated on sync.`,
          path: manifestPath
        });
      }

      if (report.manifest.missingGeneratedFileCount > 0) {
        issues.push({
          severity: "warning",
          code: "MANIFEST_MISSING_GENERATED_OUTPUTS",
          message: `${report.manifest.missingGeneratedFileCount} tracked generated file${report.manifest.missingGeneratedFileCount === 1 ? " is" : "s are"} missing and would be repaired on sync.`,
          path: manifestPath
        });
      }
    } catch (error) {
      if (error instanceof CorruptStateError) {
        report.manifest.valid = false;
        if (options.repair) {
          const backupPath = await backupFile(manifestPath);
          await manifestStore.writeManifest(inspectManifestValue(undefined).manifest);
          report.manifest.valid = true;
          report.manifest.linkedFileCount = 0;
          report.manifest.backupPath = backupPath;
          issues.push({
            severity: "warning",
            code: "MANIFEST_CORRUPT",
            message: `${error.message} The manifest was repaired from a backup.`,
            path: manifestPath
          });
          actions.push(`Backed up the corrupt manifest to ${backupPath} and wrote a fresh empty manifest.`);
          repairPerformed = true;
        } else {
          issues.push({
            severity: "error",
            code: "MANIFEST_CORRUPT",
            message: error.message,
            path: manifestPath
          });
        }
      } else {
        throw error;
      }
    }
  }

  try {
    const authInspection = await inspectCliAuthState(tokenPath, authManager, driveClient);
    report.auth = authInspection.auth;
    issues.push(...authInspection.issues);
  } catch (error) {
    if (error instanceof CorruptStateError) {
      report.auth.sessionFileExists = true;
      if (options.repair && (await pathExists(tokenPath))) {
        const backupPath = await backupFile(tokenPath);
        report.auth.backupPath = backupPath;
        report.auth.sessionValid = false;
        report.auth.authenticated = false;
        report.auth.refreshTokenPresent = false;
        report.auth.scopeMatchesConfig = false;
        issues.push({
          severity: "warning",
          code: "AUTH_SESSION_CORRUPT",
          message: `${error.message} The saved CLI session was cleared so you can sign in again cleanly.`,
          path: tokenPath
        });
        actions.push(`Backed up the corrupt CLI OAuth session to ${backupPath} and cleared the saved session.`);
        repairPerformed = true;
      } else {
        issues.push({
          severity: "error",
          code: "AUTH_SESSION_CORRUPT",
          message: error.message,
          path: tokenPath
        });
      }
    } else {
      issues.push({
        severity: "warning",
        code: "AUTH_INSPECTION_FAILED",
        message: error instanceof Error ? error.message : "Failed to inspect the saved CLI auth session.",
        path: tokenPath
      });
    }
  }

  report.repair.performed = repairPerformed;
  return report;
}

export function formatDoctorReport(report: CliDoctorReport): string {
  const lines: string[] = [
    `GDriveSync doctor for ${report.rootPath}`,
    `Manifest: ${report.manifest.valid ? "ok" : "corrupt"}${report.manifest.exists ? ` (${report.manifest.linkedFileCount} linked)` : " (not created yet)"}`,
    `Auth: ${
      report.auth.authenticated
        ? `signed in${report.auth.currentUserEmail ? ` as ${report.auth.currentUserEmail}` : ""}`
        : "not signed in"
    }`
  ];

  if (report.issues.length === 0) {
    lines.push("No issues found.");
  } else {
    lines.push("Issues:");
    for (const issue of report.issues) {
      lines.push(`- [${issue.severity}] ${issue.code}: ${issue.message}`);
    }
  }

  if (report.repair.actions.length > 0) {
    lines.push("Repair actions:");
    for (const action of report.repair.actions) {
      lines.push(`- ${action}`);
    }
  }

  return lines.join("\n");
}
