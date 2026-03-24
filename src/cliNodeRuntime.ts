import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

import { resolveDefaultCliCacheRoot } from "./appleVisionOcr";
import { CliImageEnrichmentConfigStore, resolveDefaultCliConfigPath } from "./cliImageEnrichmentConfig";
import { CliIo, CliRuntime, CliServices } from "./cliCore";
import { CliManifestStore } from "./cliManifestStore";
import { CliSyncManager } from "./cliSync";
import { DriveClient } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { ImageEnrichmentService } from "./imageEnrichment";
import { EnvironmentOrStoredCloudKeyResolver, KeychainCloudProviderKeyStore } from "./providerKeyStores";
import { loadDevelopmentEnv, resolveCliGoogleConfig } from "./runtimeConfig";
import { SlidesClient } from "./slidesClient";
import { FileOAuthStateStore } from "./tokenStores";

function openExternalUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const command =
      process.platform === "darwin"
        ? { bin: "open", args: [url] }
        : process.platform === "win32"
          ? { bin: "cmd", args: ["/c", "start", "", url] }
          : { bin: "xdg-open", args: [url] };

    const child = spawn(command.bin, command.args, {
      stdio: "ignore",
      detached: process.platform !== "win32"
    });
    child.on("error", () => resolve(false));
    child.unref();
    resolve(true);
  });
}

export function createNodeCliIo(): CliIo {
  async function promptLine(prompt: string, options?: { secret?: boolean }): Promise<string> {
    const stdin = process.stdin;
    const stderr = process.stderr;
    const useMaskedInput = Boolean(options?.secret && stdin.isTTY && stderr.isTTY);

    let muted = false;
    const output = useMaskedInput
      ? new Writable({
          write(chunk, encoding, callback) {
            if (!muted) {
              stderr.write(chunk, encoding as BufferEncoding);
            }
            callback();
          }
        })
      : stderr;

    const rl = createInterface({
      input: stdin,
      output,
      terminal: Boolean(stdin.isTTY && stderr.isTTY)
    });

    try {
      stderr.write(`${prompt}: `);
      muted = useMaskedInput;
      const value = (await rl.question("")).trim();
      if (useMaskedInput) {
        stderr.write("\n");
      }
      return value;
    } finally {
      muted = false;
      rl.close();
    }
  }

  return {
    writeStdout(value: string) {
      process.stdout.write(value);
    },
    writeStderr(value: string) {
      process.stderr.write(value);
    },
    async promptSecret(prompt: string): Promise<string> {
      const value = await promptLine(prompt, { secret: true });
      if (!value) {
        throw new Error("No API key was entered.");
      }
      return value;
    },
    async promptChoice<T>(
      prompt: string,
      options: Array<{ label: string; value: T; detail?: string }>
    ): Promise<T | undefined> {
      while (true) {
        process.stderr.write(`${prompt}\n`);
        options.forEach((option, index) => {
          process.stderr.write(`  ${index + 1}. ${option.label}${option.detail ? ` — ${option.detail}` : ""}\n`);
        });
        const answer = await promptLine("Choose an option (Enter to cancel)");
        if (!answer) {
          return undefined;
        }

        const selectedIndex = Number(answer);
        if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= options.length) {
          return options[selectedIndex - 1]?.value;
        }

        process.stderr.write("Enter the number for one of the options above.\n\n");
      }
    }
  };
}

export function createDefaultCliRuntime(cwd = process.cwd()): CliRuntime {
  return {
    cwd,
    async loadDevelopmentEnv(workdir: string): Promise<void> {
      await loadDevelopmentEnv(workdir);
    },
    resolveWorkspaceRoot(cwdFlag?: string): string {
      return path.resolve(cwdFlag || cwd);
    },
    createServices(workspaceRoot: string): CliServices {
      const tokenPath = path.join(os.homedir(), ".gdrivesync-dev-session.json");
      const tokenStore = new FileOAuthStateStore(tokenPath);
      const authManager = new GoogleAuthManager(tokenStore, resolveCliGoogleConfig, openExternalUrl);
      const driveClient = new DriveClient();
      const slidesClient = new SlidesClient();
      const cloudKeyStore = new KeychainCloudProviderKeyStore();
      const cloudKeyResolver = new EnvironmentOrStoredCloudKeyResolver(cloudKeyStore);
      const cliImageEnrichmentConfigStore = new CliImageEnrichmentConfigStore(resolveDefaultCliConfigPath());
      const imageEnrichmentService = new ImageEnrichmentService(
        resolveDefaultCliCacheRoot(),
        path.resolve(__dirname, "../resources/appleVisionOcr.swift"),
        cloudKeyResolver
      );
      const manifestStore = new CliManifestStore(workspaceRoot);
      const syncManager = new CliSyncManager(authManager, driveClient, manifestStore, slidesClient, imageEnrichmentService);

      return {
        tokenPath,
        authManager,
        driveClient,
        slidesClient,
        cloudKeyStore,
        cloudKeyResolver,
        cliImageEnrichmentConfigStore,
        imageEnrichmentService,
        manifestStore,
        syncManager
      };
    }
  };
}
