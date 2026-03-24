import path from "node:path";

import * as vscode from "vscode";

import { CloudImageProvider, formatCloudProviderLabel, resolveCloudModel } from "./cloudImageProviders";
import { DriveClient, PickerGrantRequiredError } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { ImageEnrichmentService } from "./imageEnrichment";
import { ManifestStore } from "./manifestStore";
import { PickerClient } from "./pickerClient";
import { SecretStorageCloudProviderKeyStore, formatCloudCredentialSource } from "./providerKeyStores";
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

let activeSyncManager: SyncManager | undefined;

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

function getCloudConsentStateKey(provider: CloudImageProvider): string {
  return `gdocSync.imageEnrichment.cloudConsent.${provider}`;
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
  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    await loadDevelopmentEnv(context.extensionPath);
  }

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
  const cloudProviderKeyStore = new SecretStorageCloudProviderKeyStore(context.secrets);
  const driveClient = new DriveClient();
  const pickerClient = new PickerClient(resolveExtensionGoogleConfig);
  const outputChannel = vscode.window.createOutputChannel("GDriveSync");
  context.subscriptions.push(outputChannel);
  const imageEnrichmentService = new ImageEnrichmentService(
    path.join(context.globalStorageUri.fsPath, "image-enrichment"),
    path.join(context.extensionPath, "resources", "appleVisionOcr.swift"),
    cloudProviderKeyStore
  );
  const syncManager = new SyncManager(
    authManager,
    driveClient,
    manifestStore,
    new SlidesClient(),
    imageEnrichmentService,
    {
      info(message: string) {
        outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
      }
    },
    {
      confirmCloudConsent: async (provider) => {
        const consentKey = getCloudConsentStateKey(provider);
        const storedConsent = context.globalState.get<boolean | undefined>(consentKey);
        if (storedConsent !== undefined) {
          return storedConsent;
        }

        const providerLabel = formatCloudProviderLabel(provider);
        const selection = await vscode.window.showWarningMessage(
          `${providerLabel} image enrichment sends eligible images to ${providerLabel} for analysis. API charges may apply. Allow ${providerLabel} for future syncs?`,
          { modal: true },
          `Allow ${providerLabel}`,
          "Keep local-only behavior"
        );
        const allowed = selection === `Allow ${providerLabel}`;
        await context.globalState.update(consentKey, allowed);
        return allowed;
      },
      handleImageEnrichmentOutcome: async (details) => {
        if (details.reason === "open" || !details.cloudProvider || details.failureMessages.length === 0) {
          return;
        }

        const providerLabel = formatCloudProviderLabel(details.cloudProvider);
        const normalizedMessages = details.failureMessages.join(" ").toLowerCase();
        const looksLikeAuthFailure =
          normalizedMessages.includes("401") ||
          normalizedMessages.includes("403") ||
          normalizedMessages.includes("api key") ||
          normalizedMessages.includes("authentication") ||
          normalizedMessages.includes("unauthorized") ||
          normalizedMessages.includes("forbidden");
        if (!looksLikeAuthFailure) {
          const selection = await vscode.window.showWarningMessage(
            `${providerLabel} image enrichment had problems. Check the GDriveSync output channel for details.`,
            "Open Output",
            "Configure Image Enrichment"
          );
          if (selection === "Open Output") {
            outputChannel.show(true);
          } else if (selection === "Configure Image Enrichment") {
            await vscode.commands.executeCommand("gdocSync.configureImageEnrichment");
          }
          return;
        }

        const alternativeProviders = (["openai", "anthropic"] as const)
          .filter((provider) => provider !== details.cloudProvider);
        const configuredAlternatives: CloudImageProvider[] = [];
        for (const provider of alternativeProviders) {
          const resolved = await imageEnrichmentService.resolveCloudApiKey(provider);
          if (resolved.apiKey) {
            configuredAlternatives.push(provider);
          }
        }

        const alternative = configuredAlternatives[0];
        const selection = await vscode.window.showWarningMessage(
          `${providerLabel} image enrichment failed, likely because the configured credentials are no longer valid.`,
          alternative ? `Switch to ${formatCloudProviderLabel(alternative)} default` : "Configure Image Enrichment",
          "Open Output"
        );
        if (selection === "Open Output") {
          outputChannel.show(true);
          return;
        }
        if (alternative && selection === `Switch to ${formatCloudProviderLabel(alternative)} default`) {
          await vscode.workspace
            .getConfiguration("gdocSync")
            .update("imageEnrichment.cloudProvider", alternative, vscode.ConfigurationTarget.Global);
          logInfo(`Switched default cloud image enrichment provider to ${formatCloudProviderLabel(alternative)} after ${providerLabel} auth failure.`);
          void vscode.window.showInformationMessage(
            `Default cloud image enrichment provider is now ${formatCloudProviderLabel(alternative)}.`
          );
          return;
        }
        await vscode.commands.executeCommand("gdocSync.configureImageEnrichment");
      }
    }
  );
  activeSyncManager = syncManager;
  context.subscriptions.push({
    dispose: () => {
      syncManager.dispose();
      if (activeSyncManager === syncManager) {
        activeSyncManager = undefined;
      }
    }
  });
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const codeLensEmitter = new vscode.EventEmitter<void>();

  function logInfo(message: string): void {
    outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  function logError(contextMessage: string, error: unknown): void {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    outputChannel.appendLine(`[${new Date().toISOString()}] ERROR: ${contextMessage}`);
    outputChannel.appendLine(detail);
  }

  async function runLoggedCommand<T>(commandName: string, task: () => Promise<T>): Promise<T> {
    logInfo(`Command ${commandName} started.`);
    try {
      const result = await task();
      logInfo(`Command ${commandName} completed.`);
      return result;
    } catch (error) {
      logError(`Command ${commandName} failed.`, error);
      outputChannel.show(true);
      throw error;
    }
  }

  const initialRuntimeConfig = resolveExtensionGoogleConfig();
  logInfo(
    `Activated. Hosted picker origin: ${initialRuntimeConfig.hostedBaseUrl || "not configured"}.`
  );

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
      logInfo("Picker requested a newly connected Google account.");
      const connectedAccount = await authManager.connectAccount();
      return connectedAccount;
    }

    if (selection && typeof selection !== "string") {
      logInfo(`Picker will use ${formatAccountLabel(selection)}.`);
    }
    return typeof selection === "string" ? undefined : selection;
  }

  function getCloudModelOverride(): string | undefined {
    return vscode.workspace.getConfiguration("gdocSync").get<string>("imageEnrichment.cloudModel")?.trim() || undefined;
  }

  function getConfiguredCloudModel(provider: CloudImageProvider): string {
    return resolveCloudModel(provider, getCloudModelOverride());
  }

  function getCurrentImageEnrichmentMode(): "prompt" | "off" | "local" | "cloud" | "hybrid" {
    return vscode.workspace.getConfiguration("gdocSync").get("imageEnrichment.mode", "prompt");
  }

  function getCurrentCloudProvider(): CloudImageProvider {
    return vscode.workspace.getConfiguration("gdocSync").get("imageEnrichment.cloudProvider", "openai");
  }

  function formatImageEnrichmentMode(mode: string): string {
    if (mode === "off") {
      return "Off";
    }
    if (mode === "prompt") {
      return "Prompt";
    }
    if (mode === "local") {
      return "Local OCR";
    }
    if (mode === "cloud") {
      return "Cloud AI";
    }
    if (mode === "hybrid") {
      return "Hybrid";
    }

    return mode;
  }

  async function getCloudConsent(provider: CloudImageProvider): Promise<boolean | undefined> {
    return context.globalState.get<boolean | undefined>(getCloudConsentStateKey(provider));
  }

  async function setCloudConsent(provider: CloudImageProvider, allowed: boolean): Promise<void> {
    await context.globalState.update(getCloudConsentStateKey(provider), allowed);
  }

  async function ensureCloudConsent(provider: CloudImageProvider): Promise<boolean> {
    const providerLabel = formatCloudProviderLabel(provider);
    const existingConsent = await getCloudConsent(provider);
    if (existingConsent === true) {
      return true;
    }

    const selection = await vscode.window.showWarningMessage(
      `${providerLabel} image enrichment sends eligible images directly to ${providerLabel}. API charges may apply. Allow ${providerLabel}?`,
      { modal: true },
      `Allow ${providerLabel}`,
      "Keep current behavior"
    );
    const allowed = selection === `Allow ${providerLabel}`;
    await setCloudConsent(provider, allowed);
    return allowed;
  }

  async function getConfiguredCloudProviders(): Promise<CloudImageProvider[]> {
    const providers: CloudImageProvider[] = [];
    for (const provider of ["openai", "anthropic"] as const) {
      const resolved = await imageEnrichmentService.resolveCloudApiKey(provider);
      if (resolved.apiKey) {
        providers.push(provider);
      }
    }

    return providers;
  }

  async function maybePromptToUseCloud(provider: CloudImageProvider): Promise<boolean> {
    const currentMode = getCurrentImageEnrichmentMode();
    if (currentMode === "cloud") {
      return false;
    }

    const providerLabel = formatCloudProviderLabel(provider);
    const selection = await vscode.window.showInformationMessage(
      `${providerLabel} is now configured. Switch image enrichment to cloud mode, or keep the current mode (${formatImageEnrichmentMode(currentMode)})?`,
      "Switch to cloud",
      `Keep current mode (${formatImageEnrichmentMode(currentMode)})`
    );
    if (selection !== "Switch to cloud") {
      return false;
    }

    const consentGranted = await ensureCloudConsent(provider);
    if (!consentGranted) {
      logInfo(`Cloud image enrichment with ${providerLabel} remained disabled because consent was not granted.`);
      return false;
    }

    await vscode.workspace.getConfiguration("gdocSync").update("imageEnrichment.cloudProvider", provider, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("gdocSync").update("imageEnrichment.mode", "cloud", vscode.ConfigurationTarget.Global);
    logInfo(`Image enrichment mode switched to cloud with ${providerLabel}.`);
    void vscode.window.showInformationMessage(`Image enrichment now uses cloud mode with ${providerLabel}.`);
    return true;
  }

  async function activateCloudMode(provider: CloudImageProvider): Promise<boolean> {
    const providerLabel = formatCloudProviderLabel(provider);
    const currentMode = getCurrentImageEnrichmentMode();

    const consentGranted = await ensureCloudConsent(provider);
    if (!consentGranted) {
      logInfo(`Cloud image enrichment with ${providerLabel} remained disabled because consent was not granted.`);
      return false;
    }

    await vscode.workspace.getConfiguration("gdocSync").update("imageEnrichment.cloudProvider", provider, vscode.ConfigurationTarget.Global);
    if (currentMode !== "cloud") {
      await vscode.workspace.getConfiguration("gdocSync").update("imageEnrichment.mode", "cloud", vscode.ConfigurationTarget.Global);
      logInfo(`Image enrichment mode switched to cloud with ${providerLabel}.`);
      void vscode.window.showInformationMessage(`Image enrichment now uses cloud mode with ${providerLabel}.`);
      return true;
    }

    logInfo(`Confirmed cloud image enrichment consent for ${providerLabel}.`);
    return false;
  }

  async function maybePromptToSwitchCloudDefault(provider: CloudImageProvider): Promise<boolean> {
    const configuredProviders = await getConfiguredCloudProviders();
    if (configuredProviders.length < 2) {
      return false;
    }

    const currentProvider = getCurrentCloudProvider();
    if (currentProvider === provider) {
      return false;
    }

    const currentLabel = formatCloudProviderLabel(currentProvider);
    const nextLabel = formatCloudProviderLabel(provider);
    const selection = await vscode.window.showInformationMessage(
      `${nextLabel} is configured. Keep ${currentLabel} as the default cloud provider, or switch to ${nextLabel}?`,
      `Keep ${currentLabel} default`,
      `Switch to ${nextLabel} default`
    );
    if (selection !== `Switch to ${nextLabel} default`) {
      return false;
    }

    await vscode.workspace.getConfiguration("gdocSync").update("imageEnrichment.cloudProvider", provider, vscode.ConfigurationTarget.Global);
    logInfo(`Default cloud image enrichment provider switched to ${nextLabel}.`);
    void vscode.window.showInformationMessage(`Default cloud image enrichment provider is now ${nextLabel}.`);
    return true;
  }

  async function connectCloudApiKey(
    provider: CloudImageProvider,
    options?: { promptToUseCloud?: boolean }
  ): Promise<boolean> {
    await ensureTrustedWorkspace();
    const providerLabel = formatCloudProviderLabel(provider);
    const apiKey = await vscode.window.showInputBox({
      title: `Connect ${providerLabel} API Key`,
      prompt: `Paste your ${providerLabel} API key. It will be stored in VS Code SecretStorage on this machine.`,
      password: true,
      ignoreFocusOut: true
    });
    if (!apiKey?.trim()) {
      logInfo(`${providerLabel} API key connect flow cancelled.`);
      return false;
    }

    await cloudProviderKeyStore.set(provider, apiKey);
    logInfo(`Stored ${providerLabel} API key in SecretStorage.`);
    const shouldPromptToUseCloud = options?.promptToUseCloud ?? true;
    if (!shouldPromptToUseCloud) {
      return true;
    }

    const switchedToCloud = await maybePromptToUseCloud(provider);
    if (!switchedToCloud) {
      await maybePromptToSwitchCloudDefault(provider);
      void vscode.window.showInformationMessage(`Stored ${providerLabel} API key in VS Code SecretStorage.`);
    }
    return true;
  }

  async function disconnectCloudApiKey(provider: CloudImageProvider): Promise<void> {
    await ensureTrustedWorkspace();
    const providerLabel = formatCloudProviderLabel(provider);
    await cloudProviderKeyStore.delete(provider);
    const remainingProviders = await getConfiguredCloudProviders();
    if (getCurrentCloudProvider() === provider && remainingProviders.length > 0) {
      const nextProvider = remainingProviders[0];
      await vscode.workspace
        .getConfiguration("gdocSync")
        .update("imageEnrichment.cloudProvider", nextProvider, vscode.ConfigurationTarget.Global);
      logInfo(`Default cloud image enrichment provider switched to ${formatCloudProviderLabel(nextProvider)} after removing ${providerLabel}.`);
    }
    logInfo(`Removed ${providerLabel} API key from SecretStorage.`);
    void vscode.window.showInformationMessage(`Removed ${providerLabel} API key from VS Code SecretStorage.`);
  }

  async function testCloudProvider(provider: CloudImageProvider): Promise<void> {
    await ensureTrustedWorkspace();
    const providerLabel = formatCloudProviderLabel(provider);
    const result = await imageEnrichmentService.testCloudProvider(provider, getCloudModelOverride());
    logInfo(
      `${providerLabel} provider test succeeded using ${result.model} from ${formatCloudCredentialSource(result.keySource)}.`
    );
    void vscode.window.showInformationMessage(
      `${providerLabel} is configured and reachable using ${result.model} from ${formatCloudCredentialSource(result.keySource)}.`
    );
  }

  async function configureLocalImageEnrichment(): Promise<void> {
    await ensureTrustedWorkspace();
    const capabilities = await imageEnrichmentService.inspectCapabilities();
    const items: Array<vscode.QuickPickItem & { provider?: "auto" | "apple-vision" | "tesseract" }> = [];

    if (capabilities.appleVision.available && capabilities.tesseract.available) {
      items.push({
        label: "Use Local OCR (Auto)",
        detail: "Apple Vision preferred, Tesseract fallback",
        provider: "auto"
      });
    }
    if (capabilities.appleVision.available) {
      items.push({
        label: "Use Apple Vision",
        detail: "Best local OCR quality on macOS",
        provider: "apple-vision"
      });
    }
    if (capabilities.tesseract.available) {
      items.push({
        label: "Use Tesseract",
        detail: "Cross-platform local OCR",
        provider: "tesseract"
      });
    }

    if (items.length === 0) {
      void vscode.window.showWarningMessage(
        "No local OCR provider is currently available. Install Tesseract, or use a macOS setup with Apple Vision and the Swift compiler."
      );
      return;
    }

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: "Choose the local OCR provider to use"
    });
    if (!selection?.provider) {
      logInfo("Configure local image enrichment cancelled.");
      return;
    }

    await vscode.workspace.getConfiguration("gdocSync").update("imageEnrichment.mode", "local", vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("gdocSync").update("imageEnrichment.provider", selection.provider, vscode.ConfigurationTarget.Global);
    logInfo(`Configured local image enrichment using ${selection.provider}.`);
    void vscode.window.showInformationMessage(`Image enrichment now uses local OCR (${selection.provider}).`);
  }

  async function configureCloudImageEnrichment(): Promise<void> {
    await ensureTrustedWorkspace();
    const currentMode = getCurrentImageEnrichmentMode();
    const currentProvider = getCurrentCloudProvider();
    const selection = await vscode.window.showQuickPick(
      [
        {
          label: "OpenAI",
          detail: `Model ${getConfiguredCloudModel("openai")} • ${currentProvider === "openai" ? "current default" : "available"}`
        },
        {
          label: "Anthropic",
          detail: `Model ${getConfiguredCloudModel("anthropic")} • ${currentProvider === "anthropic" ? "current default" : "available"}`
        }
      ],
      {
        placeHolder: `Choose the cloud provider to use or configure (current mode: ${formatImageEnrichmentMode(currentMode)})`
      }
    );
    if (!selection) {
      logInfo("Configure cloud image enrichment cancelled.");
      return;
    }

    const provider = selection.label === "OpenAI" ? "openai" : "anthropic";
    const resolved = await imageEnrichmentService.resolveCloudApiKey(provider);
    const providerLabel = formatCloudProviderLabel(provider);
    const action = await vscode.window.showQuickPick(
      resolved.apiKey
        ? [
            {
              label: `Use ${providerLabel}`,
              detail:
                currentProvider === provider
                  ? `Current default cloud provider • mode ${formatImageEnrichmentMode(currentMode)}`
                  : `Configured via ${formatCloudCredentialSource(resolved.source)}`
            },
            {
              label: `Reconnect ${providerLabel} API Key...`,
              detail: "Replace the stored API key"
            },
            {
              label: `Disconnect ${providerLabel} API Key`,
              detail: "Remove the stored API key from SecretStorage"
            },
            {
              label: `Test ${providerLabel}`,
              detail: `Check the configured key with model ${getConfiguredCloudModel(provider)}`
            }
          ]
        : [
            {
              label: `Configure ${providerLabel} API Key...`,
              detail: "Store a provider key in SecretStorage"
            }
          ],
      {
        placeHolder: `Choose what to do with ${providerLabel}`
      }
    );
    if (!action) {
      logInfo(`Configure cloud image enrichment cancelled at ${providerLabel} action picker.`);
      return;
    }

    if (action.label.startsWith("Configure ") || action.label.startsWith("Reconnect ")) {
      const connected = await connectCloudApiKey(provider, { promptToUseCloud: false });
      if (!connected) {
        return;
      }

      if (getCurrentImageEnrichmentMode() !== "cloud") {
        const switchedToCloud = await activateCloudMode(provider);
        if (!switchedToCloud && getCurrentImageEnrichmentMode() !== "cloud") {
          void vscode.window.showInformationMessage(
            `${providerLabel} is configured, but image enrichment is still using ${formatImageEnrichmentMode(getCurrentImageEnrichmentMode())}.`
          );
        }
        return;
      }

      if (getCurrentCloudProvider() !== provider) {
        await maybePromptToSwitchCloudDefault(provider);
      }

      await ensureCloudConsent(provider);
      return;
    } else if (action.label.startsWith("Disconnect ")) {
      await disconnectCloudApiKey(provider);
      return;
    } else if (action.label.startsWith("Test ")) {
      await testCloudProvider(provider);
      return;
    } else {
      const switchedToCloud = await activateCloudMode(provider);
      if (!switchedToCloud && currentProvider !== provider) {
        await maybePromptToSwitchCloudDefault(provider);
      } else if (!switchedToCloud && currentProvider === provider && currentMode === "cloud") {
        void vscode.window.showInformationMessage(`${providerLabel} is already the default cloud provider.`);
      }
    }

    if (getCurrentImageEnrichmentMode() === "cloud" && getCurrentCloudProvider() === provider) {
      await ensureCloudConsent(provider);
    }
  }

  async function configureImageEnrichment(): Promise<void> {
    await ensureTrustedWorkspace();
    const currentMode = getCurrentImageEnrichmentMode();
    const currentCloudProvider = getCurrentCloudProvider();
    const configuredCloudProviders = await getConfiguredCloudProviders();
    const localCapabilities = await imageEnrichmentService.inspectCapabilities();
    const localSummary = localCapabilities.appleVision.available || localCapabilities.tesseract.available
      ? [
          localCapabilities.appleVision.available ? "Apple Vision" : undefined,
          localCapabilities.tesseract.available ? "Tesseract" : undefined
        ]
          .filter(Boolean)
          .join(", ")
      : "No local OCR provider available";
    const cloudSummary = configuredCloudProviders.length > 0
      ? `Configured: ${configuredCloudProviders.map((provider) => formatCloudProviderLabel(provider)).join(", ")}`
      : "No cloud providers configured";

    const selection = await vscode.window.showQuickPick(
      [
        {
          label: "Use local OCR",
          detail: `${localSummary} • current mode ${formatImageEnrichmentMode(currentMode)}`
        },
        {
          label: "Use cloud AI",
          detail: `${cloudSummary} • current default ${formatCloudProviderLabel(currentCloudProvider)}`
        },
        {
          label: "Turn image enrichment off",
          detail: `Current mode ${formatImageEnrichmentMode(currentMode)}`
        },
        ...(configuredCloudProviders.includes(currentCloudProvider)
          ? [
              {
                label: `Test ${formatCloudProviderLabel(currentCloudProvider)}`,
                detail: `Current default cloud provider • model ${getConfiguredCloudModel(currentCloudProvider)}`
              }
            ]
          : [])
      ],
      {
        placeHolder: "Configure image enrichment"
      }
    );
    if (!selection) {
      logInfo("Configure Image Enrichment dismissed.");
      return;
    }

    if (selection.label === "Use local OCR") {
      await configureLocalImageEnrichment();
      return;
    }
    if (selection.label === "Use cloud AI") {
      await configureCloudImageEnrichment();
      return;
    }
    if (selection.label === "Turn image enrichment off") {
      await vscode.workspace.getConfiguration("gdocSync").update("imageEnrichment.mode", "off", vscode.ConfigurationTarget.Global);
      logInfo("Turned image enrichment off.");
      void vscode.window.showInformationMessage("Image enrichment is now off.");
      return;
    }
    if (selection.label.startsWith("Test ")) {
      await testCloudProvider(currentCloudProvider);
    }
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
        logInfo(`Trying pasted Google file ${parsedInput.fileId} with ${formatAccountLabel(account)}.`);
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
        logInfo(
          `Connected account ${formatAccountLabel(account)} could not resolve file ${parsedInput.fileId}: ${sanitizeError(error)}`
        );
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
      logInfo("Selection flow: hosted Google Picker.");
      const pickerAccount = await chooseAccountForPicker();
      if (!pickerAccount) {
        logInfo("Google Picker selection cancelled before account choice completed.");
        return undefined;
      }

      const pickedFile = await pickerClient.pickDocument(
        {
          ...pickerOptions,
          loginHint: pickerAccount.accountEmail
        }
      );
      if (!pickedFile) {
        logInfo("Google Picker closed without a file selection.");
        return undefined;
      }
      logInfo(`Google Picker selected file ${pickedFile.fileId}.`);

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
      logInfo("Selection flow: pasted Google file input cancelled.");
      return undefined;
    }
    logInfo(`Selection flow: pasted Google file input for ${parsedInput.fileId}.`);

    try {
      return await resolveSelectionFromInput(parsedInput, allowedProfiles);
    } catch (error) {
      if (shouldRecoverAccessWithPicker(parsedInput, error)) {
        logInfo(`Pasted input ${parsedInput.fileId} needs picker recovery.`);
        void vscode.window.showInformationMessage(
          `That shared Google file may need extra link access details. Opening Google Picker to recover them…`
        );
        const pickerAccount = await chooseAccountForPicker();
        if (!pickerAccount) {
          logInfo("Picker recovery cancelled before account choice completed.");
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
          logInfo("Picker recovery closed without a file selection.");
          return undefined;
        }
        logInfo(`Picker recovery selected file ${pickedFile.fileId}.`);
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
    logInfo(`Linking local file ${localFileUri.fsPath}.`);
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
    logInfo(`Linked ${localFileUri.fsPath}: ${outcome.message}`);
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
    logInfo("Import Google file flow started.");
    const selection = await selectDocument(getSupportedSyncProfiles());
    if (!selection) {
      logInfo("Import Google file flow cancelled before selection.");
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
    logInfo(`Imported ${selection.fileId} to ${targetUri.fsPath}: ${outcome.message}`);
    await openImportedOutput(targetUri);
    await refreshUi();
    await showSyncOutcome(outcome);
  }

  async function syncCurrentFile(targetUri?: vscode.Uri): Promise<void> {
    await ensureConnectedAccount();
    const localFileUri = getTargetLocalFileUri(targetUri);
    logInfo(`Syncing current file ${localFileUri.fsPath}.`);
    const linkedFile = await manifestStore.getLinkedFile(localFileUri);
    const baseTargetUri = linkedFile ? vscode.Uri.file(fromManifestKey(linkedFile.folderPath, linkedFile.key)) : localFileUri;
    const outcome = await withSyncProgress("Syncing from Google…", (progress) =>
      syncManager.syncFile(localFileUri, { reason: "manual", progress })
    );
    logInfo(`Sync result for ${localFileUri.fsPath}: ${outcome.message}`);
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
    logInfo(`Sync on open for ${localFileUri.fsPath} is now ${enabled ? "enabled" : "disabled"}.`);
    await refreshUi();
    void vscode.window.showInformationMessage(
      enabled ? "Auto-sync on open is now enabled for this linked file." : "Auto-sync on open is now disabled."
    );
  }

  async function unlinkCurrentFile(targetUri?: vscode.Uri): Promise<void> {
    await ensureTrustedWorkspace();
    const localFileUri = getTargetLocalFileUri(targetUri);
    const removed = await syncManager.unlinkFile(localFileUri, { removeGeneratedFiles: false });
    logInfo(`Unlink ${localFileUri.fsPath}: ${removed ? "removed link" : "no link found"}.`);
    await refreshUi();
    if (removed) {
      void vscode.window.showInformationMessage("The file is no longer linked to Google.");
    }
  }

  async function connectGoogleAccount(): Promise<void> {
    await ensureTrustedWorkspace();
    await ensureDesktopConfig();
    const connectedAccount = await authManager.connectAccount();
    logInfo(`Connected ${formatAccountLabel(connectedAccount)}.`);
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
      logInfo("Disconnect Google account cancelled.");
      return;
    }

    if (selection === "disconnect-all") {
      const disconnectResult = await authManager.disconnectAll();
      logInfo(`Disconnected all Google accounts (${disconnectResult.disconnectedCount}).`);
      for (const warning of disconnectResult.revokeWarnings) {
        logInfo(`Google revoke warning: ${warning}`);
      }
      await refreshUi();
      void vscode.window.showInformationMessage(
        disconnectResult.disconnectedCount === 1
          ? "Disconnected 1 Google account."
          : `Disconnected ${disconnectResult.disconnectedCount} Google accounts.`
      );
      if (disconnectResult.revokeWarnings.length > 0) {
        void vscode.window.showWarningMessage(
          "Some Google tokens could not be revoked remotely. The local accounts were removed, but you may still want to review connected apps in your Google account."
        );
      }
      return;
    }

    if (selection === "connect-another") {
      logInfo("Disconnect Google account picker returned connect-another; no disconnect performed.");
      return;
    }

    const disconnectResult = await authManager.disconnectAccount(selection.accountId);
    if (disconnectResult.account) {
      logInfo(`Disconnected ${formatAccountLabel(disconnectResult.account)}.`);
    }
    if (disconnectResult.revokeWarning) {
      logInfo(`Google revoke warning: ${disconnectResult.revokeWarning}`);
    }
    await refreshUi();
    if (disconnectResult.account) {
      void vscode.window.showInformationMessage(`Disconnected ${formatAccountLabel(disconnectResult.account)}.`);
    }
    if (disconnectResult.revokeWarning) {
      void vscode.window.showWarningMessage(
        "Google could not confirm token revocation remotely. The local account was removed, but you may still want to review connected apps in your Google account."
      );
    }
  }

  async function switchDefaultGoogleAccount(): Promise<void> {
    await ensureTrustedWorkspace();
    const selection = await chooseConnectedAccount({
      title: "Choose the default Google account"
    });
    if (!selection || typeof selection === "string") {
      logInfo("Switch default Google account cancelled.");
      return;
    }

    const account = await authManager.setDefaultAccount(selection.accountId);
    logInfo(`Default Google account changed to ${formatAccountLabel(account)}.`);
    await refreshUi();
    void vscode.window.showInformationMessage(`Default Google account is now ${formatAccountLabel(account)}.`);
  }

  async function showGoogleAccounts(): Promise<void> {
    await ensureTrustedWorkspace();
    const accounts = await authManager.listAccounts();
    if (accounts.length === 0) {
      logInfo("Google Accounts opened with no connected accounts.");
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
      logInfo("Google Accounts picker dismissed.");
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
      logInfo(`Auto-unlinked ${unlinkedCount} deleted file${unlinkedCount === 1 ? "" : "s"}.`);
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
        await runLoggedCommand("gdocSync.connectGoogleAccount", connectGoogleAccount);
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.disconnectGoogleAccount", async () => {
      try {
        await runLoggedCommand("gdocSync.disconnectGoogleAccount", disconnectGoogleAccount);
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.switchDefaultGoogleAccount", async () => {
      try {
        await runLoggedCommand("gdocSync.switchDefaultGoogleAccount", switchDefaultGoogleAccount);
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.googleAccounts", async () => {
      try {
        await runLoggedCommand("gdocSync.googleAccounts", showGoogleAccounts);
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.configureImageEnrichment", async () => {
      try {
        await runLoggedCommand("gdocSync.configureImageEnrichment", configureImageEnrichment);
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.linkCurrentFile", async (uri?: vscode.Uri) => {
      try {
        await runLoggedCommand("gdocSync.linkCurrentFile", () => linkLocalFile(uri));
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.importGoogleDoc", async () => {
      try {
        await runLoggedCommand("gdocSync.importGoogleDoc", importGoogleFile);
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.syncCurrentFile", async (uri?: vscode.Uri) => {
      try {
        await runLoggedCommand("gdocSync.syncCurrentFile", () => syncCurrentFile(uri));
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.syncAll", async () => {
      try {
        await runLoggedCommand("gdocSync.syncAll", async () => {
          await ensureConnectedAccount();
          const summary = await withSyncProgress("Syncing all linked files…", (progress) => syncManager.syncAll({ progress }));
          logInfo(
            `Sync all completed: synced=${summary.syncedCount}, skipped=${summary.skippedCount}, cancelled=${summary.cancelledCount}.`
          );
          await showSyncAllOutcome(summary);
        });
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.toggleSyncOnOpen", async (uri?: vscode.Uri) => {
      try {
        await runLoggedCommand("gdocSync.toggleSyncOnOpen", () => toggleSyncOnOpen(uri));
      } catch (error) {
        void vscode.window.showErrorMessage(sanitizeError(error));
      }
    }),
    vscode.commands.registerCommand("gdocSync.unlinkCurrentFile", async (uri?: vscode.Uri) => {
      try {
        await runLoggedCommand("gdocSync.unlinkCurrentFile", () => unlinkCurrentFile(uri));
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
        event.affectsConfiguration("gdocSync.imageEnrichment.cloudProvider") ||
        event.affectsConfiguration("gdocSync.imageEnrichment.cloudModel") ||
        event.affectsConfiguration("gdocSync.imageEnrichment.maxImagesPerRun") ||
        event.affectsConfiguration("gdocSync.imageEnrichment.store") ||
        event.affectsConfiguration("gdocSync.imageEnrichment.onlyWhenAltGeneric") ||
        event.affectsConfiguration("gdocSync.development.desktopClientId") ||
        event.affectsConfiguration("gdocSync.development.desktopClientSecret") ||
        event.affectsConfiguration("gdocSync.development.hostedBaseUrl") ||
        event.affectsConfiguration("gdocSync.development.loginHint")
      ) {
        logInfo("Relevant extension configuration changed; refreshing UI state.");
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

export function deactivate(): void {
  activeSyncManager?.dispose();
  activeSyncManager = undefined;
}
