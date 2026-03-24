import { AsyncEntry } from "@napi-rs/keyring";
import type { SecretStorage } from "vscode";

import { CloudCredentialSource, CloudImageKeyResolver, CloudImageProvider, ResolvedCloudApiKey } from "./cloudImageProviders";

const EXTENSION_PROVIDER_SECRET_PREFIX = "gdocSync.imageEnrichment.cloudProvider.";
const CLI_KEYCHAIN_SERVICE = "gdrivesync.ai";

export function getProviderEnvVar(provider: CloudImageProvider): string {
  return provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}

function getProviderSecretKey(provider: CloudImageProvider): string {
  return `${EXTENSION_PROVIDER_SECRET_PREFIX}${provider}`;
}

function getProviderAccountName(provider: CloudImageProvider): string {
  return `${provider}-api-key`;
}

function normalizeCloudApiKey(rawValue: string | undefined): string | undefined {
  const trimmed = rawValue?.trim();
  return trimmed ? trimmed : undefined;
}

export interface CloudProviderKeyStore {
  get(provider: CloudImageProvider): Promise<string | undefined>;
  set(provider: CloudImageProvider, apiKey: string): Promise<void>;
  delete(provider: CloudImageProvider): Promise<void>;
}

export class SecretStorageCloudProviderKeyStore implements CloudProviderKeyStore, CloudImageKeyResolver {
  constructor(private readonly secrets: SecretStorage) {}

  async get(provider: CloudImageProvider): Promise<string | undefined> {
    return normalizeCloudApiKey(await this.secrets.get(getProviderSecretKey(provider)));
  }

  async set(provider: CloudImageProvider, apiKey: string): Promise<void> {
    await this.secrets.store(getProviderSecretKey(provider), apiKey.trim());
  }

  async delete(provider: CloudImageProvider): Promise<void> {
    await this.secrets.delete(getProviderSecretKey(provider));
  }

  async resolve(provider: CloudImageProvider): Promise<ResolvedCloudApiKey> {
    const apiKey = await this.get(provider);
    return {
      provider,
      apiKey,
      source: apiKey ? "secret-storage" : "missing"
    };
  }
}

export class KeychainCloudProviderKeyStore implements CloudProviderKeyStore {
  private getEntry(provider: CloudImageProvider): AsyncEntry {
    return new AsyncEntry(CLI_KEYCHAIN_SERVICE, getProviderAccountName(provider));
  }

  async get(provider: CloudImageProvider): Promise<string | undefined> {
    try {
      return normalizeCloudApiKey(await this.getEntry(provider).getPassword());
    } catch {
      return undefined;
    }
  }

  async set(provider: CloudImageProvider, apiKey: string): Promise<void> {
    try {
      await this.getEntry(provider).setPassword(apiKey.trim());
    } catch (error) {
      throw new Error(
        `The OS keychain is unavailable for storing the ${provider} API key. Use ${getProviderEnvVar(provider)} instead. ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async delete(provider: CloudImageProvider): Promise<void> {
    try {
      await this.getEntry(provider).deleteCredential();
    } catch {
      // Best effort only.
    }
  }
}

export class EnvironmentOrStoredCloudKeyResolver implements CloudImageKeyResolver {
  constructor(
    private readonly store: CloudProviderKeyStore,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  async resolve(provider: CloudImageProvider): Promise<ResolvedCloudApiKey> {
    const environmentValue = normalizeCloudApiKey(this.env[getProviderEnvVar(provider)]);
    if (environmentValue) {
      return {
        provider,
        apiKey: environmentValue,
        source: "environment"
      };
    }

    const storedValue = await this.store.get(provider);
    return {
      provider,
      apiKey: storedValue,
      source: storedValue ? "keychain" : "missing"
    };
  }
}

export function formatCloudCredentialSource(source: CloudCredentialSource): string {
  if (source === "secret-storage") {
    return "SecretStorage";
  }
  if (source === "keychain") {
    return "keychain";
  }
  if (source === "environment") {
    return "environment";
  }

  return "missing";
}
