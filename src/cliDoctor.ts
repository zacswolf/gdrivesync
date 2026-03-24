import { mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

import { CliManifestStore } from "./cliManifestStore";
import { DriveClient } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { inspectManifestValue, parseManifestText } from "./manifestSchema";
import { resolveCliGoogleConfig } from "./runtimeConfig";
import { normalizeStoredOAuthState } from "./sessionSchema";
import { CorruptStateError } from "./stateErrors";
import { ConnectedGoogleAccount } from "./types";
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
    accountCount: number;
    refreshTokenPresent: boolean;
    scopeMatchesConfig: boolean;
    defaultAccountId?: string;
    defaultAccountEmail?: string;
    scope?: string;
    expiresAt?: string;
    expiresInSeconds?: number;
    accounts?: Array<{
      accountId: string;
      accountEmail?: string;
      accountDisplayName?: string;
      isDefault: boolean;
      scope?: string;
      expiresAt?: string;
      refreshTokenPresent: boolean;
    }>;
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
    accountCount: 0,
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
  let parsedAccounts: ConnectedGoogleAccount[] = [];
  let defaultAccount: ConnectedGoogleAccount | undefined;
  try {
    const parsedState = normalizeStoredOAuthState(JSON.parse(rawSession), tokenPath);
    parsedAccounts = Object.values(parsedState.accounts);
    defaultAccount = parsedState.defaultAccountId ? parsedState.accounts[parsedState.defaultAccountId] : parsedAccounts[0];
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CorruptStateError("oauth-session", tokenPath);
    }

    throw error;
  }
  auth.authenticated = parsedAccounts.length > 0;
  auth.sessionValid = parsedAccounts.length > 0;
  auth.accountCount = parsedAccounts.length;
  auth.defaultAccountId = defaultAccount?.accountId;
  auth.defaultAccountEmail = defaultAccount?.accountEmail;
  auth.refreshTokenPresent = parsedAccounts.some((account) => Boolean(account.session.refreshToken));
  auth.scope = defaultAccount?.session.scope;
  auth.scopeMatchesConfig = parsedAccounts.every((account) => hasRequiredScopes(account.session.scope, config.scope));
  auth.expiresAt = defaultAccount ? new Date(defaultAccount.session.expiresAt).toISOString() : undefined;
  auth.expiresInSeconds = defaultAccount
    ? Math.max(0, Math.floor((defaultAccount.session.expiresAt - Date.now()) / 1000))
    : undefined;
  auth.accounts = parsedAccounts.map((account) => ({
    accountId: account.accountId,
    accountEmail: account.accountEmail,
    accountDisplayName: account.accountDisplayName,
    isDefault: defaultAccount?.accountId === account.accountId,
    scope: account.session.scope,
    expiresAt: new Date(account.session.expiresAt).toISOString(),
    refreshTokenPresent: Boolean(account.session.refreshToken)
  }));

  if (!auth.scopeMatchesConfig) {
    issues.push({
      severity: "warning",
      code: "AUTH_SCOPE_MISMATCH",
      message: "The saved CLI Google session is missing the current required Drive read-only scope. Sign in again to refresh it.",
      path: tokenPath
    });
  }

  try {
    for (const account of parsedAccounts) {
      await authManager.getAccessToken(account.accountId);
    }
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
      accountCount: 0,
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

  if (report.auth.accounts && report.auth.accounts.length > 0) {
    const knownAccountIds = new Set(report.auth.accounts.map((account) => account.accountId));
    let missingBindingCount = 0;
    let removedBindingCount = 0;
    const manifest = await manifestStore.readManifest();
    for (const entry of Object.values(manifest.files)) {
      if (!entry.accountId) {
        missingBindingCount += 1;
        continue;
      }

      if (!knownAccountIds.has(entry.accountId)) {
        removedBindingCount += 1;
      }
    }

    if (missingBindingCount > 0) {
      issues.push({
        severity: "warning",
        code: "MANIFEST_MISSING_ACCOUNT_BINDINGS",
        message: `${missingBindingCount} linked file${missingBindingCount === 1 ? "" : "s"} are missing an account binding and will bind on next successful sync.`,
        path: manifestStore.getManifestPath()
      });
    }

    if (removedBindingCount > 0) {
      issues.push({
        severity: "warning",
        code: "MANIFEST_MISSING_CONNECTED_ACCOUNTS",
        message: `${removedBindingCount} linked file${removedBindingCount === 1 ? "" : "s"} reference disconnected Google accounts and may need recovery on next sync.`,
        path: manifestStore.getManifestPath()
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
        ? `signed in${report.auth.defaultAccountEmail ? ` as ${report.auth.defaultAccountEmail}` : ""}`
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
