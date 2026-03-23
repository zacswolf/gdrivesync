import path from "node:path";

import * as vscode from "vscode";

import { DriveClient, PickerGrantRequiredError } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { ManifestStore } from "./manifestStore";
import { PickerClient } from "./pickerClient";
import { assertDesktopClientConfigured, resolveExtensionGoogleConfig } from "./runtimeConfig";
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

async function promptForDocInput(): Promise<ParsedDocInput | undefined> {
  const value = await vscode.window.showInputBox({
    placeHolder: "Paste a Google Docs URL or doc ID",
    prompt: "Paste a Google Docs URL or raw doc ID."
  });
  if (!value) {
    return undefined;
  }

  const parsed = parseGoogleDocInput(value);
  if (!parsed) {
    throw new Error("That does not look like a Google Docs URL or document ID.");
  }

  return parsed;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const manifestStore = new ManifestStore();
  const authManager = new GoogleAuthManager(new SecretStorageTokenStore(context.secrets), resolveExtensionGoogleConfig);
  const driveClient = new DriveClient();
  const pickerClient = new PickerClient(resolveExtensionGoogleConfig);
  const syncManager = new SyncManager(authManager, driveClient, manifestStore);
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  async function ensureTrustedWorkspace(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      throw new Error("GDriveSync is disabled in untrusted workspaces.");
    }
  }

  async function ensureDesktopConfig(): Promise<void> {
    assertDesktopClientConfigured(resolveExtensionGoogleConfig());
  }

  async function updateStatusBar(): Promise<void> {
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
    statusBarItem.text = linkedFile.entry.syncOnOpen ? "$(sync) GDoc: Auto" : "$(cloud-download) GDoc";
    statusBarItem.tooltip = `${linkedFile.entry.title}\nClick to sync from Google Docs.`;
    statusBarItem.show();
  }

  async function ensureSignedIn(): Promise<void> {
    await ensureTrustedWorkspace();
    await ensureDesktopConfig();
    await authManager.ensureSignedIn();
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
          label: "Paste Google Docs URL or ID",
          detail: "Paste a direct Docs URL or raw document ID."
        }
      ],
      {
        placeHolder: "Choose how to link your Google Doc"
      }
    );

    if (!selectionMode) {
      return undefined;
    }

    if (selectionMode.label === "Select from Google Drive") {
      return pickerClient.pickDocument();
    }

    const parsedInput = await promptForDocInput();
    if (!parsedInput) {
      return undefined;
    }

    try {
      const accessToken = await authManager.getAccessToken();
      const metadata = await driveClient.getFileMetadata(accessToken, parsedInput.docId, parsedInput.resourceKey);
      return {
        docId: metadata.id,
        title: metadata.name,
        sourceUrl: metadata.webViewLink || parsedInput.sourceUrl,
        resourceKey: metadata.resourceKey || parsedInput.resourceKey
      };
    } catch (error) {
      if (error instanceof PickerGrantRequiredError) {
        void vscode.window.showInformationMessage(
          "Google needs you to open that Doc through Picker once before drive.file access is granted."
        );
        return pickerClient.pickDocument(parsedInput);
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
    await updateStatusBar();
    void vscode.window.showInformationMessage(outcome.message);
  }

  async function importGoogleDoc(): Promise<void> {
    await ensureSignedIn();
    const selection = await selectDocument();
    if (!selection) {
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error("Open a workspace folder before importing a Google Doc.");
    }

    const targetUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, `${slugifyForFileName(selection.title)}.md`)),
      filters: {
        Markdown: ["md"]
      },
      saveLabel: "Import Google Doc"
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
    await updateStatusBar();
    void vscode.window.showInformationMessage(outcome.message);
  }

  async function syncCurrentFile(targetUri?: vscode.Uri): Promise<void> {
    await ensureSignedIn();
    const markdownUri = getTargetMarkdownUri(targetUri);
    const outcome = await syncManager.syncFile(markdownUri, { reason: "manual" });
    await updateStatusBar();
    if (outcome.status !== "skipped") {
      void vscode.window.showInformationMessage(outcome.message);
    }
  }

  async function toggleSyncOnOpen(targetUri?: vscode.Uri): Promise<void> {
    await ensureTrustedWorkspace();
    const markdownUri = getTargetMarkdownUri(targetUri);
    const enabled = await syncManager.toggleSyncOnOpen(markdownUri);
    await updateStatusBar();
    void vscode.window.showInformationMessage(
      enabled ? "Auto-sync on open is now enabled for this Markdown file." : "Auto-sync on open is now disabled."
    );
  }

  async function unlinkCurrentFile(targetUri?: vscode.Uri): Promise<void> {
    await ensureTrustedWorkspace();
    const markdownUri = getTargetMarkdownUri(targetUri);
    const removed = await manifestStore.unlinkFile(markdownUri);
    await updateStatusBar();
    if (removed) {
      void vscode.window.showInformationMessage("The Markdown file is no longer linked to a Google Doc.");
    }
  }

  context.subscriptions.push(
    statusBarItem,
    vscode.commands.registerCommand("gdocSync.signIn", async () => {
      try {
        await ensureTrustedWorkspace();
        await ensureDesktopConfig();
        await authManager.signIn();
        await updateStatusBar();
        void vscode.window.showInformationMessage("GDriveSync is now signed in.");
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.signOut", async () => {
      try {
        await ensureTrustedWorkspace();
        await authManager.signOut();
        await updateStatusBar();
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
        await importGoogleDoc();
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
        event.affectsConfiguration("gdocSync.development.desktopClientId") ||
        event.affectsConfiguration("gdocSync.development.hostedBaseUrl")
      ) {
        void updateStatusBar();
      }
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.uri.scheme === "file" && document.languageId === "markdown" && vscode.workspace.isTrusted) {
        syncManager.scheduleSyncOnOpen(document.uri);
      }
    })
  );

  await updateStatusBar();
}

export function deactivate(): void {}
