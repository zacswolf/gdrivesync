import path from "node:path";

import * as vscode from "vscode";

import { DriveClient, PickerGrantRequiredError } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { ManifestStore } from "./manifestStore";
import { PickerClient } from "./pickerClient";
import { assertDesktopClientConfigured, loadDevelopmentEnv, resolveExtensionGoogleConfig } from "./runtimeConfig";
import { getDefaultSyncProfile, getSupportedSourceMimeTypes, resolveSyncProfileForMimeType } from "./syncProfiles";
import { SyncManager } from "./syncManager";
import { SecretStorageTokenStore } from "./tokenStores";
import { ParsedDocInput, PickerSelection } from "./types";
import { parseGoogleDocInput } from "./utils/docUrl";
import { slugifyForFileName } from "./utils/paths";

function isMarkdownUri(uri: vscode.Uri | undefined): uri is vscode.Uri {
  return uri !== undefined && uri.fsPath.toLowerCase().endsWith(".md");
}

function getTargetMarkdownUri(uri?: vscode.Uri): vscode.Uri {
  if (isMarkdownUri(uri)) {
    return uri;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (isMarkdownUri(activeUri)) {
    return activeUri;
  }

  throw new Error("Open a Markdown file first.");
}

function sanitizeError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function buildCodeLensTitle(syncOnOpen: boolean): string {
  return syncOnOpen ? "Sync from Google • Auto on Open" : "Sync from Google";
}

async function promptForGoogleFileInput(): Promise<ParsedDocInput | undefined> {
  const value = await vscode.window.showInputBox({
    placeHolder: "Paste a Google Docs, Drive, or DOCX file URL or ID",
    prompt: "Paste a Google Docs or Google Drive file URL, or a raw file ID."
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

  const manifestStore = new ManifestStore();
  const authManager = new GoogleAuthManager(new SecretStorageTokenStore(context.secrets), resolveExtensionGoogleConfig);
  const driveClient = new DriveClient();
  const pickerClient = new PickerClient(resolveExtensionGoogleConfig);
  const syncManager = new SyncManager(authManager, driveClient, manifestStore);
  const selectionProfile = getDefaultSyncProfile();
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const codeLensEmitter = new vscode.EventEmitter<void>();

  async function refreshUi(): Promise<void> {
    await updateStatusBar();
    codeLensEmitter.fire();
  }

  async function updateActiveFileContext(): Promise<void> {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeLinkedFile = isMarkdownUri(activeUri) ? await manifestStore.getLinkedFile(activeUri) : undefined;
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
    if (!isMarkdownUri(activeUri)) {
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

  async function ensureSignedIn(): Promise<void> {
    await ensureTrustedWorkspace();
    await ensureDesktopConfig();
    await authManager.ensureSignedIn();
  }

  async function resolveSelectionFromInput(parsedInput: ParsedDocInput): Promise<PickerSelection> {
    const accessToken = await authManager.getAccessToken();
    const metadata = await driveClient.getFileMetadata(accessToken, {
      fileId: parsedInput.fileId,
      resourceKey: parsedInput.resourceKey,
      expectedMimeTypes: getSupportedSourceMimeTypes(),
      sourceTypeLabel: "supported Google file"
    });
    const resolvedProfile = resolveSyncProfileForMimeType(metadata.mimeType);
    if (!resolvedProfile) {
      throw new Error("This Google file type is not supported for Markdown sync yet.");
    }

    return {
      profileId: resolvedProfile.id,
      fileId: metadata.id,
      title: metadata.name,
      sourceUrl: metadata.webViewLink || resolvedProfile.buildSourceUrl(metadata.id),
      sourceMimeType: metadata.mimeType,
      resourceKey: metadata.resourceKey || parsedInput.resourceKey
    };
  }

  async function selectDocument(): Promise<PickerSelection | undefined> {
    const selectionMode = await vscode.window.showQuickPick(
      [
        {
          label: "Select from Google Drive",
          description: "Recommended",
          detail: "Open the hosted Google Picker flow."
        },
        {
          label: "Paste Google file URL or ID",
          detail: "Paste a direct Docs, Drive, or DOCX file URL, or a raw file ID."
        }
      ],
      {
        placeHolder: `Choose how to link your ${selectionProfile.sourceTypeLabel}`
      }
    );

    if (!selectionMode) {
      return undefined;
    }

    if (selectionMode.label === "Select from Google Drive") {
      const pickedFile = await pickerClient.pickDocument(selectionProfile);
      return pickedFile ? resolveSelectionFromInput(pickedFile) : undefined;
    }

    const parsedInput = await promptForGoogleFileInput();
    if (!parsedInput) {
      return undefined;
    }

    try {
      return await resolveSelectionFromInput(parsedInput);
    } catch (error) {
      if (error instanceof PickerGrantRequiredError) {
        void vscode.window.showInformationMessage(
          `Google needs one browser grant for that ${selectionProfile.sourceTypeLabel} before drive.file access is available.`
        );
        const pickedFile = await pickerClient.pickDocument(selectionProfile, parsedInput);
        return pickedFile ? resolveSelectionFromInput(pickedFile) : undefined;
      }

      throw error;
    }
  }

  async function linkMarkdownFile(targetUri?: vscode.Uri): Promise<void> {
    await ensureSignedIn();
    const markdownUri = getTargetMarkdownUri(targetUri);
    const selection = await selectDocument();
    if (!selection) {
      return;
    }

    const outcome = await syncManager.linkFile(markdownUri, selection);
    await refreshUi();
    void vscode.window.showInformationMessage(outcome.message);
  }

  async function importGoogleFile(): Promise<void> {
    await ensureSignedIn();
    const selection = await selectDocument();
    if (!selection) {
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error(`Open a workspace folder before importing a ${selectionProfile.sourceTypeLabel}.`);
    }

    const targetUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(workspaceFolder.uri.fsPath, `${slugifyForFileName(selection.title)}.${selectionProfile.targetFileExtension}`)
      ),
      filters: {
        Markdown: [selectionProfile.targetFileExtension]
      },
      saveLabel: `Import ${selectionProfile.sourceTypeLabel}`
    });

    if (!targetUri) {
      return;
    }

    if (!vscode.workspace.getWorkspaceFolder(targetUri)) {
      throw new Error("Imported Markdown files must live inside an open workspace folder.");
    }

    const outcome = await syncManager.linkFile(targetUri, selection);
    const openedDocument = await vscode.workspace.openTextDocument(targetUri);
    await vscode.window.showTextDocument(openedDocument, { preview: false });
    await refreshUi();
    void vscode.window.showInformationMessage(outcome.message);
  }

  async function syncCurrentFile(targetUri?: vscode.Uri): Promise<void> {
    await ensureSignedIn();
    const markdownUri = getTargetMarkdownUri(targetUri);
    const outcome = await syncManager.syncFile(markdownUri, { reason: "manual" });
    await refreshUi();
    if (outcome.status !== "skipped") {
      void vscode.window.showInformationMessage(outcome.message);
    }
  }

  async function toggleSyncOnOpen(targetUri?: vscode.Uri): Promise<void> {
    await ensureTrustedWorkspace();
    const markdownUri = getTargetMarkdownUri(targetUri);
    const enabled = await syncManager.toggleSyncOnOpen(markdownUri);
    await refreshUi();
    void vscode.window.showInformationMessage(
      enabled ? "Auto-sync on open is now enabled for this Markdown file." : "Auto-sync on open is now disabled."
    );
  }

  async function unlinkCurrentFile(targetUri?: vscode.Uri): Promise<void> {
    await ensureTrustedWorkspace();
    const markdownUri = getTargetMarkdownUri(targetUri);
    const removed = await syncManager.unlinkFile(markdownUri, { removeGeneratedAssets: false });
    await refreshUi();
    if (removed) {
      void vscode.window.showInformationMessage("The file is no longer linked to Google.");
    }
  }

  async function handleDeletedMarkdownFiles(files: readonly vscode.Uri[]): Promise<void> {
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
      if (!isMarkdownUri(file)) {
        continue;
      }

      const removed = await syncManager.unlinkFile(file, { removeGeneratedAssets: true });
      if (removed) {
        unlinkedCount += 1;
      }
    }

    if (unlinkedCount > 0) {
      await refreshUi();
      void vscode.window.setStatusBarMessage(
        unlinkedCount === 1 ? "Unlinked deleted Markdown file from Google." : `Unlinked ${unlinkedCount} deleted Markdown files from Google.`,
        4000
      );
    }
  }

  const codeLensProvider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: codeLensEmitter.event,
    async provideCodeLenses(document) {
      if (document.uri.scheme !== "file" || document.languageId !== "markdown") {
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
    vscode.languages.registerCodeLensProvider({ scheme: "file", language: "markdown" }, codeLensProvider),
    vscode.commands.registerCommand("gdocSync.signIn", async () => {
      try {
        await ensureTrustedWorkspace();
        await ensureDesktopConfig();
        await authManager.signIn();
        await refreshUi();
        void vscode.window.showInformationMessage("GDriveSync is now signed in.");
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.signOut", async () => {
      try {
        await ensureTrustedWorkspace();
        await authManager.signOut();
        await refreshUi();
        void vscode.window.showInformationMessage("Signed out of GDriveSync.");
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.linkCurrentFile", async (uri?: vscode.Uri) => {
      try {
        await linkMarkdownFile(uri);
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
        await ensureSignedIn();
        const summary = await syncManager.syncAll();
        const linkedCount = summary.results.length;
        void vscode.window.showInformationMessage(`Synced ${summary.syncedCount} of ${linkedCount} linked Markdown files.`);
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
        event.affectsConfiguration("gdocSync.development.desktopClientId") ||
        event.affectsConfiguration("gdocSync.development.desktopClientSecret") ||
        event.affectsConfiguration("gdocSync.development.hostedBaseUrl")
      ) {
        void updateStatusBar();
      }
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.uri.scheme === "file" && document.languageId === "markdown" && vscode.workspace.isTrusted) {
        syncManager.scheduleSyncOnOpen(document.uri);
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      void handleDeletedMarkdownFiles(event.files);
    })
  );

  await refreshUi();
}

export function deactivate(): void {}
