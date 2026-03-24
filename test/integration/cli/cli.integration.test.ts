import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

function resolveCliConfigPath(homeDir: string, xdgConfigHome: string, appData: string): string {
  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "GDriveSync", "cli-config.json");
  }
  if (process.platform === "win32") {
    return path.join(appData, "GDriveSync", "cli-config.json");
  }
  return path.join(xdgConfigHome, "gdrivesync", "cli-config.json");
}

async function createSandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gdrivesync-cli-integration-"));
  const workspace = path.join(root, "workspace");
  const homeDir = path.join(root, "home");
  const xdgConfigHome = path.join(root, "xdg-config");
  const appData = path.join(root, "appdata");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(homeDir, { recursive: true }), mkdir(xdgConfigHome, { recursive: true }), mkdir(appData, { recursive: true })]);

  return {
    root,
    workspace,
    homeDir,
    xdgConfigHome,
    appData,
    cliConfigPath: resolveCliConfigPath(homeDir, xdgConfigHome, appData),
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      APPDATA: appData,
      GDRIVESYNC_DESKTOP_CLIENT_ID: "test-desktop-client-id",
      GDRIVESYNC_DESKTOP_CLIENT_SECRET: "test-desktop-client-secret"
    }
  };
}

async function runCli(args: string[], sandbox: Awaited<ReturnType<typeof createSandbox>>, input?: string) {
  const cliPath = path.resolve(process.cwd(), "dist/cli.js");
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: sandbox.workspace,
      env: sandbox.env,
      stdio: "pipe"
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

describe("CLI integration", () => {
  const sandboxes: string[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.map((sandbox) => rm(sandbox, { recursive: true, force: true })));
    sandboxes.length = 0;
  });

  it("emits pure JSON for doctor in a fresh sandbox", async () => {
    const sandbox = await createSandbox();
    sandboxes.push(sandbox.root);

    const result = await runCli(["doctor", "--cwd", sandbox.workspace, "--json"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "doctor",
      data: {
        rootPath: sandbox.workspace,
        imageEnrichment: {
          config: {
            exists: false
          }
        }
      }
    });
  });

  it("repairs a corrupt CLI image-enrichment config through doctor --repair", async () => {
    const sandbox = await createSandbox();
    sandboxes.push(sandbox.root);
    await mkdir(path.dirname(sandbox.cliConfigPath), { recursive: true });
    await writeFile(sandbox.cliConfigPath, "{not-json\n", "utf8");

    const result = await runCli(["doctor", "--cwd", sandbox.workspace, "--json", "--repair"], sandbox);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      command: "doctor",
      data: {
        repair: {
          performed: true
        },
        imageEnrichment: {
          config: {
            valid: true
          }
        }
      }
    });
    const repairedConfig = JSON.parse(await readFile(sandbox.cliConfigPath, "utf8"));
    expect(repairedConfig).toEqual({
      version: 1,
      imageEnrichment: {
        mode: "off",
        provider: "auto",
        cloudProvider: "openai",
        maxImagesPerRun: 25,
        store: "alt-plus-comment"
      }
    });
  });

  it("supports scripted stdin for configure image-enrichment and keeps stdout JSON-only", async () => {
    const sandbox = await createSandbox();
    sandboxes.push(sandbox.root);

    const result = await runCli(["configure", "image-enrichment", "--json"], sandbox, "3\n");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Configure CLI image enrichment:");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "configure.image-enrichment",
      data: {
        imageEnrichment: {
          mode: "off"
        }
      }
    });
    const savedConfig = JSON.parse(await readFile(sandbox.cliConfigPath, "utf8"));
    expect(savedConfig.imageEnrichment.mode).toBe("off");
  });

  it("fails no-flag sync runs when the saved CLI config is corrupt", async () => {
    const sandbox = await createSandbox();
    sandboxes.push(sandbox.root);
    await mkdir(path.dirname(sandbox.cliConfigPath), { recursive: true });
    await writeFile(sandbox.cliConfigPath, "{not-json\n", "utf8");

    const result = await runCli(["sync", "--all", "--cwd", sandbox.workspace, "--json"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "sync",
      error: {
        code: "CLI_CONFIG_CORRUPT"
      }
    });
  });

  it("lets explicit image-enrichment flags bypass a corrupt saved config", async () => {
    const sandbox = await createSandbox();
    sandboxes.push(sandbox.root);
    await mkdir(path.dirname(sandbox.cliConfigPath), { recursive: true });
    await writeFile(sandbox.cliConfigPath, "{not-json\n", "utf8");

    const result = await runCli(
      [
        "sync",
        "--all",
        "--cwd",
        sandbox.workspace,
        "--json",
        "--image-enrichment",
        "local",
        "--image-enrichment-provider",
        "tesseract"
      ],
      sandbox
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "sync",
      data: {
        rootPath: sandbox.workspace,
        syncedCount: 0,
        skippedCount: 0,
        cancelledCount: 0,
        failedCount: 0
      }
    });
  });

  it("keeps parse-time argument failures machine-readable in json mode", async () => {
    const sandbox = await createSandbox();
    sandboxes.push(sandbox.root);

    const result = await runCli(["sync", "--json", "--image-enrichment", "banana"], sandbox);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      command: "unknown",
      error: {
        code: "INVALID_ARGUMENT",
        recoverable: true
      }
    });
  });
});
