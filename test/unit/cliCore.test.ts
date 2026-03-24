import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS } from "../../src/cliImageEnrichmentConfig";
import { CliIo, CliRuntime, runCli } from "../../src/cliCore";
import { CorruptStateError, ManifestBusyError } from "../../src/stateErrors";

function createFakeIo(options?: { choices?: unknown[]; secrets?: string[] }) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const choices = [...(options?.choices || [])];
  const secrets = [...(options?.secrets || [])];

  const io: CliIo = {
    writeStdout(value: string) {
      stdout.push(value);
    },
    writeStderr(value: string) {
      stderr.push(value);
    },
    async promptSecret(): Promise<string> {
      const next = secrets.shift();
      if (!next) {
        throw new Error("No scripted secret was available.");
      }
      return next;
    },
    async promptChoice<T>(): Promise<T | undefined> {
      return choices.shift() as T | undefined;
    }
  };

  return { io, stdout, stderr };
}

function createFakeRuntime(options?: {
  storedKeys?: Partial<Record<"openai" | "anthropic", string>>;
  envKeys?: Partial<Record<"openai" | "anthropic", string>>;
  configRead?: () => Promise<unknown>;
  defaults?: typeof DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS;
  authManagerOverrides?: Record<string, unknown>;
}) {
  const storedKeys = new Map<string, string>(Object.entries(options?.storedKeys || {}));
  const envKeys = new Map<string, string>(Object.entries(options?.envKeys || {}));
  const writtenDefaults: unknown[] = [];
  const syncAllCalls: unknown[] = [];
  const keyStoreActions: Array<{ action: "set" | "delete"; provider: string; value?: string }> = [];
  const testCloudProviderCalls: Array<{ provider: string; model?: string }> = [];

  const configStore = {
    read: vi.fn(async () => {
      if (options?.configRead) {
        return options.configRead();
      }
      return options?.defaults;
    }),
    write: vi.fn(async (defaults: unknown) => {
      writtenDefaults.push(defaults);
    }),
    getFilePath: vi.fn(() => "/tmp/cli-config.json")
  };

  const cloudKeyStore = {
    get: vi.fn(async (provider: string) => storedKeys.get(provider)),
    set: vi.fn(async (provider: string, value: string) => {
      storedKeys.set(provider, value);
      keyStoreActions.push({ action: "set", provider, value });
    }),
    delete: vi.fn(async (provider: string) => {
      storedKeys.delete(provider);
      keyStoreActions.push({ action: "delete", provider });
    })
  };

  const cloudKeyResolver = {
    resolve: vi.fn(async (provider: "openai" | "anthropic") => {
      const envValue = envKeys.get(provider);
      if (envValue) {
        return {
          provider,
          apiKey: envValue,
          source: "environment" as const
        };
      }

      const storedValue = storedKeys.get(provider);
      return {
        provider,
        apiKey: storedValue,
        source: storedValue ? ("keychain" as const) : ("missing" as const)
      };
    })
  };

  const imageEnrichmentService = {
    inspectCapabilities: vi.fn(async () => ({
      cacheRootPath: "/tmp/cache",
      appleVision: {
        available: true,
        compilerAvailable: true,
        helperSourceExists: true,
        status: "compiled" as const
      },
      tesseract: {
        available: true,
        path: "/usr/bin/tesseract"
      }
    })),
    testCloudProvider: vi.fn(async (provider: "openai" | "anthropic", model?: string) => {
      testCloudProviderCalls.push({ provider, model });
      return {
        provider,
        model: model || (provider === "openai" ? "gpt-5.4-nano" : "claude-haiku-4-5"),
        keySource: (envKeys.get(provider) ? "environment" : storedKeys.get(provider) ? "keychain" : "missing") as
          | "environment"
          | "keychain"
          | "missing"
      };
    })
  };

  const manifestStore = {
    getManifestPath: vi.fn(() => "/tmp/workspace/.gdrivesync.json"),
    listLinkedFiles: vi.fn(async () => []),
    getLinkedFile: vi.fn(async () => undefined)
  };

  const syncManager = {
    syncAll: vi.fn(async (syncOptions: unknown) => {
      syncAllCalls.push(syncOptions);
      return {
        results: [],
        syncedCount: 0,
        skippedCount: 0,
        cancelledCount: 0,
        failedCount: 0
      };
    }),
    syncFile: vi.fn(),
    exportSelection: vi.fn(),
    resolveSelectionFromInput: vi.fn(),
    linkFile: vi.fn(),
    unlinkFile: vi.fn()
  };

  const authManager = {
    listAccounts: vi.fn(async () => []),
    getDefaultAccount: vi.fn(async () => undefined),
    disconnectAll: vi.fn(async () => ({
      disconnectedCount: 0,
      revokeWarnings: []
    })),
    disconnectAccount: vi.fn(async () => ({})),
    ...(options?.authManagerOverrides || {})
  };

  const runtime: CliRuntime = {
    cwd: "/tmp/workspace",
    loadDevelopmentEnv: vi.fn(async () => {}),
    resolveWorkspaceRoot(cwdFlag?: string) {
      return path.resolve("/tmp/workspace", cwdFlag || ".");
    },
    createServices: vi.fn(() => ({
      tokenPath: "/tmp/home/.gdrivesync-dev-session.json",
      authManager: authManager as never,
      driveClient: {} as never,
      slidesClient: {} as never,
      cloudKeyStore: cloudKeyStore as never,
      cloudKeyResolver: cloudKeyResolver as never,
      cliImageEnrichmentConfigStore: configStore as never,
      imageEnrichmentService: imageEnrichmentService as never,
      manifestStore: manifestStore as never,
      syncManager: syncManager as never
    }))
  };

  return {
    runtime,
    configStore,
    cloudKeyStore,
    cloudKeyResolver,
    imageEnrichmentService,
    manifestStore,
    syncManager,
    writtenDefaults,
    syncAllCalls,
    keyStoreActions,
    testCloudProviderCalls,
    authManager
  };
}

describe("runCli", () => {
  it("lets explicit image-enrichment flags override corrupt saved defaults", async () => {
    const { io, stdout } = createFakeIo();
    const runtime = createFakeRuntime({
      configRead: async () => {
        throw new CorruptStateError("cli-config", "/tmp/cli-config.json");
      }
    });

    const exitCode = await runCli(
      ["sync", "--all", "--json", "--image-enrichment", "local", "--image-enrichment-provider", "tesseract"],
      runtime.runtime,
      io
    );

    expect(exitCode).toBe(0);
    expect(runtime.syncAllCalls).toEqual([
      expect.objectContaining({
        imageEnrichmentSettings: expect.objectContaining({
          mode: "local",
          provider: "tesseract"
        })
      })
    ]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: true,
      command: "sync",
      data: {
        syncedCount: 0,
        skippedCount: 0,
        cancelledCount: 0,
        failedCount: 0
      }
    });
  });

  it("surfaces corrupt saved defaults when no explicit override flags were provided", async () => {
    const { io, stdout } = createFakeIo();
    const runtime = createFakeRuntime({
      configRead: async () => {
        throw new CorruptStateError("cli-config", "/tmp/cli-config.json");
      }
    });

    const exitCode = await runCli(["sync", "--all", "--json"], runtime.runtime, io);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: false,
      command: "sync",
      error: {
        code: "CLI_CONFIG_CORRUPT"
      }
    });
  });

  it("prints revoke warnings to stderr after human auth logout flows", async () => {
    const { io, stdout, stderr } = createFakeIo();
    const runtime = createFakeRuntime({
      authManagerOverrides: {
        disconnectAll: vi.fn(async () => ({
          disconnectedCount: 2,
          revokeWarnings: ["alpha@example.com: Google token revocation failed (500): nope"]
        }))
      }
    });

    const exitCode = await runCli(["auth", "logout", "--all"], runtime.runtime, io);

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toContain("Disconnected 2 Google accounts.");
    expect(stderr.join("")).toContain("Warning: alpha@example.com: Google token revocation failed (500): nope");
  });

  it("returns a recoverable manifest-busy error payload in json mode", async () => {
    const { io, stdout } = createFakeIo();
    const runtime = createFakeRuntime();
    runtime.syncManager.syncAll = vi.fn(async () => {
      throw new ManifestBusyError("/tmp/workspace/.gdrivesync.json");
    });

    const exitCode = await runCli(["sync", "--all", "--json"], runtime.runtime, io);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: false,
      command: "sync",
      error: {
        code: "MANIFEST_BUSY",
        recoverable: true,
        path: "/tmp/workspace/.gdrivesync.json"
      }
    });
  });

  it("can turn CLI image enrichment off through the rerunnable wizard", async () => {
    const { io, stdout } = createFakeIo({
      choices: ["off"]
    });
    const runtime = createFakeRuntime({
      defaults: {
        ...DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS,
        mode: "local"
      }
    });

    const exitCode = await runCli(["configure", "image-enrichment", "--json"], runtime.runtime, io);

    expect(exitCode).toBe(0);
    expect(runtime.writtenDefaults).toEqual([
      expect.objectContaining({
        mode: "off"
      })
    ]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: true,
      command: "configure.image-enrichment",
      data: {
        imageEnrichment: {
          mode: "off"
        }
      }
    });
  });

  it("can configure a missing cloud provider key through the wizard and save cloud defaults", async () => {
    const { io, stdout } = createFakeIo({
      choices: ["cloud", "openai", "configure"],
      secrets: ["sk-openai"]
    });
    const runtime = createFakeRuntime();

    const exitCode = await runCli(["configure", "image-enrichment", "--json"], runtime.runtime, io);

    expect(exitCode).toBe(0);
    expect(runtime.keyStoreActions).toContainEqual({
      action: "set",
      provider: "openai",
      value: "sk-openai"
    });
    expect(runtime.testCloudProviderCalls).toContainEqual({
      provider: "openai",
      model: undefined
    });
    expect(runtime.writtenDefaults).toEqual([
      expect.objectContaining({
        mode: "cloud",
        cloudProvider: "openai"
      })
    ]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: true,
      command: "configure.image-enrichment",
      data: {
        imageEnrichment: {
          mode: "cloud",
          cloudProvider: "openai"
        }
      }
    });
  });

  it("can disconnect the current default cloud provider through the wizard", async () => {
    const { io, stdout } = createFakeIo({
      choices: ["cloud", "openai", "disconnect"]
    });
    const runtime = createFakeRuntime({
      defaults: {
        ...DEFAULT_CLI_IMAGE_ENRICHMENT_DEFAULTS,
        mode: "cloud",
        cloudProvider: "openai"
      },
      storedKeys: {
        openai: "stored-openai"
      }
    });

    const exitCode = await runCli(["configure", "image-enrichment", "--json"], runtime.runtime, io);

    expect(exitCode).toBe(0);
    expect(runtime.keyStoreActions).toContainEqual({
      action: "delete",
      provider: "openai"
    });
    expect(runtime.writtenDefaults).toEqual([
      expect.objectContaining({
        mode: "off"
      })
    ]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: true,
      command: "configure.image-enrichment",
      data: {
        disconnectedProvider: "openai"
      }
    });
  });

  it("surfaces provider source precedence in ai auth status", async () => {
    const { io, stdout } = createFakeIo();
    const runtime = createFakeRuntime({
      envKeys: {
        openai: "env-openai"
      },
      storedKeys: {
        anthropic: "stored-anthropic"
      }
    });

    const exitCode = await runCli(["ai", "auth", "status", "--json"], runtime.runtime, io);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      ok: true,
      command: "ai.auth.status",
      data: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            provider: "openai",
            source: "environment",
            configured: true
          }),
          expect.objectContaining({
            provider: "anthropic",
            source: "keychain",
            configured: true
          })
        ])
      }
    });
  });
});
