import path from "node:path";

import * as vscode from "vscode";

import { DriveClient, PickerGrantRequiredError } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { ImageEnrichmentService } from "./imageEnrichment";
import { ManifestStore } from "./manifestStore";
import { PickerClient } from "./pickerClient";
import { assertDesktopClientConfigured, loadDevelopmentEnv, resolveGoogleConfigFromValues } from "./runtimeConfig";
import {
  getSupportedSourceMimeTypes,
  getSupportedSyncProfiles,
  getSyncProfilesForTargetFamily,
  resolveSyncProfileForMimeType
} from "./syncProfiles";
import { SyncManager, SyncProgressReporter } from "./syncManager";
import { SecretStorageOAuthStateStore } from "./tokenStores";
import { ConnectedGoogleAccount, ParsedDocInput, PickerSelection, SyncOutcome } from "./types";
import { SlidesClient } from "./slidesClient";
import { parseGoogleDocInput, extractGoogleResourceKey } from "./utils/docUrl";
import { normalizeResolvedGoogleFileSelection, shouldRecoverAccessWithPicker } from "./utils/googleFileSelection";
import { fromManifestKey, slugifyForFileName } from "./utils/paths";

function isMarkdownUri(uri: vscode.Uri | undefined): uri is vscode.Uri {
  return uri !== undefined && uri.fsPath.toLowerCase().endsWith(".md");
}

function isCsvUri(uri: vscode.Uri | undefined): uri is vscode.Uri {
  return uri !== undefined && uri.fsPath.toLowerCase().endsWith(".csv");
}

function isSupportedOutputUri(uri: vscode.Uri | undefined): uri is vscode.Uri {
  return isMarkdownUri(uri) || isCsvUri(uri);
}

function getTargetLocalFileUri(uri?: vscode.Uri): vscode.Uri {
  if (isSupportedOutputUri(uri)) {
    return uri;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (isSupportedOutputUri(activeUri)) {
    return activeUri;
  }

  throw new Error("Open a Markdown or CSV file first.");
}

function sanitizeError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function buildCodeLensTitle(syncOnOpen: boolean): string {
  return syncOnOpen ? "Sync from Google • Auto on Open" : "Sync from Google";
}

function buildSyncAllMessage(summary: { syncedCount: number; skippedCount: number; cancelledCount: number }): string {
  const parts: string[] = [];
  if (summary.syncedCount > 0) {
    parts.push(`${summary.syncedCount} synced`);
  }
  if (summary.skippedCount > 0) {
    parts.push(`${summary.skippedCount} already up to date`);
  }
  if (summary.cancelledCount > 0) {
    parts.push(`${summary.cancelledCount} cancelled`);
  }

  return parts.length > 0 ? parts.join(", ") : "No linked files were processed.";
}

async function promptForGoogleFileInput(): Promise<ParsedDocInput | undefined> {
  const value = await vscode.window.showInputBox({
    placeHolder: "Paste a Google Docs, Slides, Sheets, Drive, DOCX, PPTX, or XLSX file URL or ID",
    prompt: "Paste a supported Google Docs, Slides, Sheets, or Drive file URL, or a raw file ID."
  });
  if (!value) {
    return undefined;
  }

  const parsed = parseGoogleDocInput(value);
  if (!parsed) {
    throw new Error("That does not look like a supported Google file URL or file ID.");
  }

  return parsed;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await loadDevelopmentEnv(context.extensionPath);

  function resolveExtensionGoogleConfig() {
    const config = vscode.workspace.getConfiguration("gdocSync");
    return resolveGoogleConfigFromValues({
      desktopClientId: config.get<string>("development.desktopClientId") || undefined,
      desktopClientSecret: config.get<string>("development.desktopClientSecret") || undefined,
      hostedBaseUrl: config.get<string>("development.hostedBaseUrl") || undefined,
      loginHint: config.get<string>("development.loginHint") || undefined
    });
  }

  const manifestStore = new ManifestStore();
  const authManager = new GoogleAuthManager(
    new SecretStorageOAuthStateStore(context.secrets),
    resolveExtensionGoogleConfig,
    async (url) => vscode.env.openExternal(vscode.Uri.parse(url))
  );
  const driveClient = new DriveClient();
  const pickerClient = new PickerClient(resolveExtensionGoogleConfig);
  const outputChannel = vscode.window.createOutputChannel("GDriveSync");
  context.subscriptions.push(outputChannel);
  const imageEnrichmentService = new ImageEnrichmentService(
    path.join(context.globalStorageUri.fsPath, "image-enrichment"),
    path.join(context.extensionPath, "resources", "appleVisionOcr.swift")
  );
  const syncManager = new SyncManager(authManager, driveClient, manifestStore, new SlidesClient(), imageEnrichmentService, {
    info(message: string) {
      outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
  });
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const codeLensEmitter = new vscode.EventEmitter<void>();

  function getProfilesForTargetUri(targetUri?: vscode.Uri) {
    if (isMarkdownUri(targetUri)) {
      return getSyncProfilesForTargetFamily("markdown");
    }
    if (isCsvUri(targetUri)) {
      return getSyncProfilesForTargetFamily("csv");
    }

    return getSupportedSyncProfiles();
  }

  function getSelectionSourceLabel(profiles = getSupportedSyncProfiles()): string {
    if (profiles.length > 0 && profiles.every((profile) => profile.targetFamily === "csv")) {
      return "Spreadsheet";
    }
    if (profiles.length > 0 && profiles.every((profile) => profile.targetFamily === "markdown")) {
      return "Google file";
    }

    return "Google file";
  }

  function getPickerOptions(profiles = getSupportedSyncProfiles()) {
    const targetFamilies = [...new Set(profiles.map((profile) => profile.targetFamily))];
    const pickerViewIds = [...new Set(profiles.map((profile) => profile.pickerViewId))];
    const pickerMimeTypes = [...new Set(profiles.flatMap((profile) => profile.pickerMimeTypes.split(",").map((value) => value.trim())))]
      .filter(Boolean)
      .join(",");
    return {
      sourceTypeLabel: getSelectionSourceLabel(profiles),
      pickerViewId: targetFamilies.length > 1 || pickerViewIds.length > 1 ? "DOCS" : profiles[0]?.pickerViewId || "DOCUMENTS",
      pickerMimeTypes
    };
  }

  function formatAccountLabel(account: ConnectedGoogleAccount): string {
    return account.accountEmail || account.accountDisplayName || account.accountId;
  }

  function shouldTryAnotherAccount(error: unknown): boolean {
    if (error instanceof PickerGrantRequiredError) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes("cannot be refreshed") ||
      message.includes("No connected Google account matches") ||
      message.includes("cannot access file") ||
      message.includes("cannot access Google file") ||
      message.includes("missing the required Drive read-only scope")
    );
  }

  async function getConnectedAccountEmail(): Promise<string | undefined> {
    const defaultAccount = await authManager.getDefaultAccount().catch(() => undefined);
    return defaultAccount?.accountEmail || resolveExtensionGoogleConfig().loginHint;
  }

  async function chooseConnectedAccount(
    options: {
      title: string;
      includeConnectAnother?: boolean;
      includeDisconnectAll?: boolean;
    }
  ): Promise<ConnectedGoogleAccount | "connect-another" | "disconnect-all" | undefined> {
    const accounts = await authManager.listAccounts();
    if (accounts.length === 0) {
      return undefined;
    }
    if (accounts.length === 1 && !options.includeConnectAnother && !options.includeDisconnectAll) {
      return accounts[0];
    }

    const defaultAccount = await authManager.getDefaultAccount();
    const items: Array<vscode.QuickPickItem & { account?: ConnectedGoogleAccount; action?: "connect-another" | "disconnect-all" }> =
      accounts.map((account) => ({
        label: formatAccountLabel(account),
        description: defaultAccount?.accountId === account.accountId ? "Default" : undefined,
        detail: account.accountDisplayName && account.accountDisplayName !== account.accountEmail ? account.accountDisplayName : undefined,
        account
      }));

    if (options.includeConnectAnother) {
      items.push({
        label: "Connect another Google account…",
        action: "connect-another"
      });
    }

    if (options.includeDisconnectAll) {
      items.push({
        label: "Disconnect all Google accounts",
        action: "disconnect-all"
      });
    }

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: options.title
    });
    if (!selection) {
      return undefined;
    }

    return selection.account || selection.action;
  }

  async function chooseAccountForPicker(): Promise<ConnectedGoogleAccount | undefined> {
    const selection = await chooseConnectedAccount({
      title: "Choose the Google account to use for Google Picker",
      includeConnectAnother: true
    });

    if (selection === "connect-another") {
      const connectedAccount = await authManager.connectAccount();
      return connectedAccount;
    }

    return typeof selection === "string" ? undefined : selection;
  }

  async function buildAccessDeniedMessage(fileId: string, account?: ConnectedGoogleAccount): Promise<string> {
    const connectedAccountEmail = account?.accountEmail || (await getConnectedAccountEmail());
    if (connectedAccountEmail) {
      return `The connected Google account (${connectedAccountEmail}) cannot access file ${fileId}. Share it with that account, or connect a Google account that can read it.`;
    }

    return `The connected Google account cannot access file ${fileId}. Share it with that account, or connect a Google account that can read it.`;
  }

  function getTargetTypeDescription(profiles = getSupportedSyncProfiles()): string {
    if (profiles.length > 0 && profiles.every((profile) => profile.targetFamily === "csv")) {
      return "CSV";
    }
    if (profiles.length > 0 && profiles.every((profile) => profile.targetFamily === "markdown")) {
      return "Markdown";
    }

    return "local file";
  }

  async function showSyncOutcome(outcome: SyncOutcome): Promise<void> {
    const generatedDirectoryPath = outcome.transition?.generatedDirectoryPath;
    if (
      outcome.transition?.kind === "spreadsheet-output-kind-changed" &&
      outcome.transition.nextOutputKind === "directory" &&
      generatedDirectoryPath
    ) {
      const selection = await vscode.window.showInformationMessage(outcome.message, "Reveal Folder");
      if (selection === "Reveal Folder") {
        await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(generatedDirectoryPath));
      }
      return;
    }

    void vscode.window.showInformationMessage(outcome.message);
  }

  async function showSyncAllOutcome(summary: {
    results: Array<{ file: string; outcome: SyncOutcome }>;
    syncedCount: number;
    skippedCount: number;
    cancelledCount: number;
  }): Promise<void> {
    const transitionedDirectories = summary.results
      .map((result) => result.outcome.transition)
      .filter(
        (transition): transition is NonNullable<SyncOutcome["transition"]> =>
          transition?.kind === "spreadsheet-output-kind-changed" &&
          transition.nextOutputKind === "directory" &&
          Boolean(transition.generatedDirectoryPath)
      );

    if (transitionedDirectories.length === 1) {
      const selection = await vscode.window.showInformationMessage(buildSyncAllMessage(summary), "Reveal Folder");
      if (selection === "Reveal Folder") {
        await vscode.commands.executeCommand(
          "revealInExplorer",
          vscode.Uri.file(transitionedDirectories[0].generatedDirectoryPath!)
        );
      }
      return;
    }

    void vscode.window.showInformationMessage(buildSyncAllMessage(summary));
  }

  async function withSyncProgress<T>(
    title: string,
    task: (progress: SyncProgressReporter) => Promise<T>
  ): Promise<T> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false
      },
      async (progress) => {
        let lastMessage: string | undefined;
        return task({
          report(message: string) {
            if (message === lastMessage) {
              return;
            }

            lastMessage = message;
            progress.report({ message });
          }
        });
      }
    );
  }

  async function refreshUi(): Promise<void> {
    await updateStatusBar();
    codeLensEmitter.fire();
  }

  async function updateActiveFileContext(): Promise<void> {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeLinkedFile = activeUri?.scheme === "file" ? await manifestStore.getLinkedFile(activeUri) : undefined;
    await vscode.commands.executeCommand("setContext", "gdocSync.activeFileLinked", Boolean(activeLinkedFile));
  }

  async function ensureTrustedWorkspace(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      throw new Error("GDriveSync is disabled in untrusted workspaces.");
    }
  }

  async function ensureDesktopConfig(): Promise<void> {
    assertDesktopClientConfigured(resolveExtensionGoogleConfig());
  }

  async function updateStatusBar(): Promise<void> {
    await updateActiveFileContext();

    const shouldShow = vscode.workspace.getConfiguration("gdocSync").get<boolean>("showStatusBar", true);
    if (!shouldShow || !vscode.workspace.isTrusted) {
      statusBarItem.hide();
      return;
    }

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri?.scheme !== "file") {
      statusBarItem.hide();
      return;
    }

    const linkedFile = await manifestStore.getLinkedFile(activeUri);
    if (!linkedFile) {
      statusBarItem.hide();
      return;
    }

    statusBarItem.command = "gdocSync.syncCurrentFile";
    statusBarItem.text =
      linkedFile.entry.syncOnOpen ? "$(sync) Sync from Google (Auto)" : "$(sync) Sync from Google";
    statusBarItem.tooltip = `${linkedFile.entry.title}\nClick to sync from Google.`;
    statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.prominentBackground");
    statusBarItem.show();
  }

  async function ensureConnectedAccount(): Promise<void> {
    await ensureTrustedWorkspace();
    await ensureDesktopConfig();
    await authManager.ensureConnected();
  }

  async function resolveSelectionFromInput(
    parsedInput: ParsedDocInput,
    allowedProfiles = getSupportedSyncProfiles()
  ): Promise<PickerSelection> {
    const parsedResourceKey = parsedInput.resourceKey || extractGoogleResourceKey(parsedInput.sourceUrl);
    const candidateAccounts = await authManager.getAccountsInPriorityOrder();
    let lastError: unknown;

    for (const account of candidateAccounts) {
      try {
        const { accessToken } = await authManager.getAccessToken(account.accountId);
        const metadata = await driveClient.getFileMetadata(accessToken, {
          fileId: parsedInput.fileId,
          resourceKey: parsedResourceKey,
          expectedMimeTypes: allowedProfiles.map((profile) => profile.sourceMimeType),
          sourceTypeLabel: "supported Google file"
        });
        const resolvedProfile = resolveSyncProfileForMimeType(metadata.mimeType);
        if (!resolvedProfile || !allowedProfiles.some((profile) => profile.id === resolvedProfile.id)) {
          throw new Error(`This Google file cannot sync to the selected ${getTargetTypeDescription(allowedProfiles)} target.`);
        }

        return {
          profileId: resolvedProfile.id,
          fileId: metadata.id,
          title: metadata.name,
          sourceUrl: metadata.webViewLink || resolvedProfile.buildSourceUrl(metadata.id),
          sourceMimeType: metadata.mimeType,
          resourceKey: metadata.resourceKey || parsedResourceKey,
          accountId: account.accountId,
          accountEmail: account.accountEmail,
          accountDisplayName: account.accountDisplayName
        };
      } catch (error) {
        lastError = error;
        if (!shouldTryAnotherAccount(error)) {
          throw error;
        }
      }
    }

    throw lastError || new Error("No connected Google account can access that file.");
  }

  async function selectDocument(allowedProfiles = getSupportedSyncProfiles()): Promise<PickerSelection | undefined> {
    const pickerOptions = getPickerOptions(allowedProfiles);
    const selectionMode = await vscode.window.showQuickPick(
      [
        {
          label: "Select from Google Drive",
          description: "Recommended",
          detail: "Open the hosted Google Picker flow."
        },
        {
          label: "Paste Google file URL or ID",
          detail: "Paste a direct Docs, Slides, Sheets, Drive, DOCX, PPTX, or XLSX file URL, or a raw file ID."
        }
      ],
      {
        placeHolder: `Choose how to link your ${getSelectionSourceLabel(allowedProfiles)}`
      }
    );

    if (!selectionMode) {
      return undefined;
    }

    if (selectionMode.label === "Select from Google Drive") {
      const pickerAccount = await chooseAccountForPicker();
      if (!pickerAccount) {
        return undefined;
      }

      const pickedFile = await pickerClient.pickDocument(
        {
          ...pickerOptions,
          loginHint: pickerAccount.accountEmail
        }
      );
      if (!pickedFile) {
        return undefined;
      }

      const normalizedSelection = normalizeResolvedGoogleFileSelection(
        pickedFile,
        allowedProfiles,
        getTargetTypeDescription(allowedProfiles)
      );
      const { accessToken } = await authManager.getAccessToken(pickerAccount.accountId);
      await driveClient.getFileMetadata(accessToken, {
        fileId: normalizedSelection.fileId,
        resourceKey: normalizedSelection.resourceKey,
        expectedMimeTypes: allowedProfiles.map((profile) => profile.sourceMimeType),
        sourceTypeLabel: "supported Google file"
      });
      return {
        ...normalizedSelection,
        accountId: pickerAccount.accountId,
        accountEmail: pickerAccount.accountEmail,
        accountDisplayName: pickerAccount.accountDisplayName
      };
    }

    const parsedInput = await promptForGoogleFileInput();
    if (!parsedInput) {
      return undefined;
    }

    try {
      return await resolveSelectionFromInput(parsedInput, allowedProfiles);
    } catch (error) {
      if (shouldRecoverAccessWithPicker(parsedInput, error)) {
        void vscode.window.showInformationMessage(
          `That shared Google file may need extra link access details. Opening Google Picker to recover them…`
        );
        const pickerAccount = await chooseAccountForPicker();
        if (!pickerAccount) {
          return undefined;
        }
        const pickedFile = await pickerClient.pickDocument(
          {
            ...pickerOptions,
            loginHint: pickerAccount.accountEmail
          },
          parsedInput
        );
        if (!pickedFile) {
          return undefined;
        }
        const normalizedSelection = normalizeResolvedGoogleFileSelection(
          pickedFile,
          allowedProfiles,
          getTargetTypeDescription(allowedProfiles)
        );
        const { accessToken } = await authManager.getAccessToken(pickerAccount.accountId);
        await driveClient.getFileMetadata(accessToken, {
          fileId: normalizedSelection.fileId,
          resourceKey: normalizedSelection.resourceKey,
          expectedMimeTypes: allowedProfiles.map((profile) => profile.sourceMimeType),
          sourceTypeLabel: "supported Google file"
        });
        return {
          ...normalizedSelection,
          accountId: pickerAccount.accountId,
          accountEmail: pickerAccount.accountEmail,
          accountDisplayName: pickerAccount.accountDisplayName
        };
      }

      if (error instanceof PickerGrantRequiredError) {
        throw new Error(await buildAccessDeniedMessage(parsedInput.fileId));
      }

      throw error;
    }
  }

  async function linkLocalFile(targetUri?: vscode.Uri): Promise<void> {
    await ensureConnectedAccount();
    const localFileUri = getTargetLocalFileUri(targetUri);
    const existingLink = await manifestStore.getLinkedFile(localFileUri);
    if (existingLink?.matchedOutputKind === "generated") {
      throw new Error("This file is generated from a linked spreadsheet. Link the base CSV file instead.");
    }

    const selection = await selectDocument(getProfilesForTargetUri(localFileUri));
    if (!selection) {
      return;
    }

    const outcome = await withSyncProgress("Linking Google file…", (progress) =>
      syncManager.linkFile(localFileUri, selection, { progress })
    );
    await refreshUi();
    await revealCurrentLinkedOutput(localFileUri);
    await showSyncOutcome(outcome);
  }

  async function openImportedOutput(baseTargetUri: vscode.Uri): Promise<void> {
    const linkedFile = await manifestStore.getLinkedFile(baseTargetUri);
    if (!linkedFile) {
      return;
    }

    if (linkedFile.entry.outputKind === "file") {
      const openedDocument = await vscode.workspace.openTextDocument(baseTargetUri);
      await vscode.window.showTextDocument(openedDocument, { preview: false });
      return;
    }

    const firstGeneratedFile = linkedFile.entry.generatedFiles?.[0];
    if (firstGeneratedFile) {
      const generatedUri = vscode.Uri.file(fromManifestKey(linkedFile.folderPath, firstGeneratedFile.relativePath));
      const openedDocument = await vscode.workspace.openTextDocument(generatedUri);
      await vscode.window.showTextDocument(openedDocument, { preview: false });
    }
  }

  async function revealCurrentLinkedOutput(currentUri: vscode.Uri, baseTargetUri = currentUri): Promise<void> {
    if (await fileExists(currentUri)) {
      return;
    }

    await openImportedOutput(baseTargetUri);
  }

  async function importGoogleFile(): Promise<void> {
    await ensureConnectedAccount();
    const selection = await selectDocument(getSupportedSyncProfiles());
    if (!selection) {
      return;
    }

    const resolvedProfile = resolveSyncProfileForMimeType(selection.sourceMimeType);
    if (!resolvedProfile) {
      throw new Error("This Google file type is not supported yet.");
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error(`Open a workspace folder before importing a ${resolvedProfile.sourceTypeLabel}.`);
    }

    const targetUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(workspaceFolder.uri.fsPath, `${slugifyForFileName(selection.title)}.${resolvedProfile.targetFileExtension}`)
      ),
      filters: {
        [resolvedProfile.targetFileExtension.toUpperCase()]: [resolvedProfile.targetFileExtension]
      },
      saveLabel: `Import ${resolvedProfile.sourceTypeLabel}`
    });

    if (!targetUri) {
      return;
    }

    if (!vscode.workspace.getWorkspaceFolder(targetUri)) {
      throw new Error("Imported local files must live inside an open workspace folder.");
    }

    const outcome = await withSyncProgress(`Importing ${resolvedProfile.sourceTypeLabel}…`, (progress) =>
      syncManager.linkFile(targetUri, selection, { progress })
    );
    await openImportedOutput(targetUri);
    await refreshUi();
    await showSyncOutcome(outcome);
  }

  async function syncCurrentFile(targetUri?: vscode.Uri): Promise<void> {
    await ensureConnectedAccount();
    const localFileUri = getTargetLocalFileUri(targetUri);
    const linkedFile = await manifestStore.getLinkedFile(localFileUri);
    const baseTargetUri = linkedFile ? vscode.Uri.file(fromManifestKey(linkedFile.folderPath, linkedFile.key)) : localFileUri;
    const outcome = await withSyncProgress("Syncing from Google…", (progress) =>
      syncManager.syncFile(localFileUri, { reason: "manual", progress })
    );
    await refreshUi();
    await revealCurrentLinkedOutput(localFileUri, baseTargetUri);
    if (outcome.status !== "skipped") {
      await showSyncOutcome(outcome);
    }
  }

  async function toggleSyncOnOpen(targetUri?: vscode.Uri): Promise<void> {
    await ensureTrustedWorkspace();
    const localFileUri = getTargetLocalFileUri(targetUri);
    const enabled = await syncManager.toggleSyncOnOpen(localFileUri);
    await refreshUi();
    void vscode.window.showInformationMessage(
      enabled ? "Auto-sync on open is now enabled for this linked file." : "Auto-sync on open is now disabled."
    );
  }

  async function unlinkCurrentFile(targetUri?: vscode.Uri): Promise<void> {
    await ensureTrustedWorkspace();
    const localFileUri = getTargetLocalFileUri(targetUri);
    const removed = await syncManager.unlinkFile(localFileUri, { removeGeneratedFiles: false });
    await refreshUi();
    if (removed) {
      void vscode.window.showInformationMessage("The file is no longer linked to Google.");
    }
  }

  async function connectGoogleAccount(): Promise<void> {
    await ensureTrustedWorkspace();
    await ensureDesktopConfig();
    const connectedAccount = await authManager.connectAccount();
    await refreshUi();
    void vscode.window.showInformationMessage(`Connected ${formatAccountLabel(connectedAccount)}.`);
  }

  async function disconnectGoogleAccount(): Promise<void> {
    await ensureTrustedWorkspace();
    const selection = await chooseConnectedAccount({
      title: "Choose the Google account to disconnect",
      includeDisconnectAll: true
    });
    if (!selection) {
      return;
    }

    if (selection === "disconnect-all") {
      const disconnectedCount = await authManager.disconnectAll();
      await refreshUi();
      void vscode.window.showInformationMessage(
        disconnectedCount === 1 ? "Disconnected 1 Google account." : `Disconnected ${disconnectedCount} Google accounts.`
      );
      return;
    }

    if (selection === "connect-another") {
      return;
    }

    const disconnectedAccount = await authManager.disconnectAccount(selection.accountId);
    await refreshUi();
    if (disconnectedAccount) {
      void vscode.window.showInformationMessage(`Disconnected ${formatAccountLabel(disconnectedAccount)}.`);
    }
  }

  async function switchDefaultGoogleAccount(): Promise<void> {
    await ensureTrustedWorkspace();
    const selection = await chooseConnectedAccount({
      title: "Choose the default Google account"
    });
    if (!selection || typeof selection === "string") {
      return;
    }

    const account = await authManager.setDefaultAccount(selection.accountId);
    await refreshUi();
    void vscode.window.showInformationMessage(`Default Google account is now ${formatAccountLabel(account)}.`);
  }

  async function showGoogleAccounts(): Promise<void> {
    await ensureTrustedWorkspace();
    const accounts = await authManager.listAccounts();
    if (accounts.length === 0) {
      const selection = await vscode.window.showInformationMessage("No Google accounts are connected yet.", "Connect Account");
      if (selection === "Connect Account") {
        await connectGoogleAccount();
      }
      return;
    }

    const defaultAccount = await authManager.getDefaultAccount();
    const selection = await vscode.window.showQuickPick(
      [
        ...accounts.map((account) => ({
          label: formatAccountLabel(account),
          description: defaultAccount?.accountId === account.accountId ? "Default" : undefined,
          detail: account.accountDisplayName && account.accountDisplayName !== account.accountEmail ? account.accountDisplayName : undefined,
          action: "account" as const,
          account
        })),
        {
          label: "Connect another Google account…",
          action: "connect" as const
        },
        {
          label: "Switch default Google account…",
          action: "switch" as const
        },
        {
          label: "Disconnect Google account…",
          action: "disconnect" as const
        }
      ],
      {
        placeHolder: "Manage connected Google accounts"
      }
    );

    if (!selection) {
      return;
    }

    if (selection.action === "connect") {
      await connectGoogleAccount();
      return;
    }
    if (selection.action === "switch") {
      await switchDefaultGoogleAccount();
      return;
    }
    if (selection.action === "disconnect") {
      await disconnectGoogleAccount();
      return;
    }

    if (selection.action === "account") {
      void vscode.window.showInformationMessage(
        `${formatAccountLabel(selection.account)}${defaultAccount?.accountId === selection.account.accountId ? " (default)" : ""}`
      );
    }
  }

  async function handleDeletedLocalFiles(files: readonly vscode.Uri[]): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      return;
    }

    const shouldUnlinkOnDelete = vscode.workspace
      .getConfiguration("gdocSync")
      .get<boolean>("unlinkOnMarkdownDelete", true);
    if (!shouldUnlinkOnDelete) {
      return;
    }

    let unlinkedCount = 0;
    for (const file of files) {
      if (!isSupportedOutputUri(file)) {
        continue;
      }

      const linkedFile = await manifestStore.getLinkedFile(file);
      if (!linkedFile || linkedFile.matchedOutputKind !== "primary" || linkedFile.entry.outputKind !== "file") {
        continue;
      }

      const removed = await syncManager.unlinkFile(file, { removeGeneratedFiles: true });
      if (removed) {
        unlinkedCount += 1;
      }
    }

    if (unlinkedCount > 0) {
      await refreshUi();
      void vscode.window.setStatusBarMessage(
        unlinkedCount === 1 ? "Unlinked deleted file from Google." : `Unlinked ${unlinkedCount} deleted files from Google.`,
        4000
      );
    }
  }

  const codeLensProvider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: codeLensEmitter.event,
    async provideCodeLenses(document) {
      if (document.uri.scheme !== "file" || (document.languageId !== "markdown" && document.languageId !== "csv")) {
        return [];
      }

      const linkedFile = await manifestStore.getLinkedFile(document.uri);
      if (!linkedFile) {
        return [];
      }

      return [
        new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title: buildCodeLensTitle(linkedFile.entry.syncOnOpen),
          tooltip: `Sync ${linkedFile.entry.title} from Google`,
          command: "gdocSync.syncCurrentFile",
          arguments: [document.uri]
        })
      ];
    }
  };

  context.subscriptions.push(
    statusBarItem,
    codeLensEmitter,
    vscode.languages.registerCodeLensProvider(
      [
        { scheme: "file", language: "markdown" },
        { scheme: "file", language: "csv" }
      ],
      codeLensProvider
    ),
    vscode.commands.registerCommand("gdocSync.connectGoogleAccount", async () => {
      try {
        await connectGoogleAccount();
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.disconnectGoogleAccount", async () => {
      try {
        await disconnectGoogleAccount();
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.switchDefaultGoogleAccount", async () => {
      try {
        await switchDefaultGoogleAccount();
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.googleAccounts", async () => {
      try {
        await showGoogleAccounts();
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.linkCurrentFile", async (uri?: vscode.Uri) => {
      try {
        await linkLocalFile(uri);
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.importGoogleDoc", async () => {
      try {
        await importGoogleFile();
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.syncCurrentFile", async (uri?: vscode.Uri) => {
      try {
        await syncCurrentFile(uri);
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.syncAll", async () => {
      try {
        await ensureConnectedAccount();
        const summary = await withSyncProgress("Syncing all linked files…", (progress) => syncManager.syncAll({ progress }));
        await showSyncAllOutcome(summary);
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.toggleSyncOnOpen", async (uri?: vscode.Uri) => {
      try {
        await toggleSyncOnOpen(uri);
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.unlinkCurrentFile", async (uri?: vscode.Uri) => {
      try {
        await unlinkCurrentFile(uri);
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      void updateStatusBar();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("gdocSync.showStatusBar") ||
        event.affectsConfiguration("gdocSync.syncOnOpenDefault") ||
        event.affectsConfiguration("gdocSync.unlinkOnMarkdownDelete") ||
        event.affectsConfiguration("gdocSync.imageEnrichment.mode") ||
        event.affectsConfiguration("gdocSync.imageEnrichment.provider") ||
        event.affectsConfiguration("gdocSync.imageEnrichment.store") ||
        event.affectsConfiguration("gdocSync.imageEnrichment.onlyWhenAltGeneric") ||
        event.affectsConfiguration("gdocSync.development.desktopClientId") ||
        event.affectsConfiguration("gdocSync.development.desktopClientSecret") ||
        event.affectsConfiguration("gdocSync.development.hostedBaseUrl")
      ) {
        void updateStatusBar();
      }
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (
        document.uri.scheme === "file" &&
        (document.languageId === "markdown" || document.languageId === "csv") &&
        vscode.workspace.isTrusted
      ) {
        syncManager.scheduleSyncOnOpen(document.uri);
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      void handleDeletedLocalFiles(event.files);
    })
  );

  await refreshUi();
}

export function deactivate(): void {}
