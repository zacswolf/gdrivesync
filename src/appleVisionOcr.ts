import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { sha256Text } from "./utils/hash";

const execFileAsync = promisify(execFile);

export interface AppleVisionCapabilityReport {
  available: boolean;
  compilerAvailable: boolean;
  helperSourceExists: boolean;
  status: "compiled" | "not-compiled" | "compile-failed" | "unavailable";
  cacheRootPath: string;
  binaryPath?: string;
}

export interface AppleVisionOcrResult {
  path: string;
  text?: string;
  error?: string;
}

interface CompileFailureRecord {
  version: 1;
  helperHash: string;
  failedAt: string;
  compilerCommand: string;
  message: string;
}

const COMPILE_FAILURE_RETRY_MS = 5 * 60 * 1000;

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveCompilerCommand(): Promise<string | undefined> {
  for (const candidate of ["xcrun", "swiftc"]) {
    try {
      await execFileAsync(candidate, ["--version"], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024
      });
      return candidate;
    } catch {
      continue;
    }
  }

  return undefined;
}

function resolveCompileArguments(sourcePath: string, binaryPath: string, compilerCommand: string): string[] {
  if (compilerCommand === "xcrun") {
    return ["swiftc", "-O", sourcePath, "-o", binaryPath];
  }

  return ["-O", sourcePath, "-o", binaryPath];
}

function buildHelperPaths(cacheRootPath: string, helperHash: string) {
  const helperDirectory = path.join(cacheRootPath, "apple-vision");
  const binaryPath = path.join(helperDirectory, `gdrivesync-apple-vision-${helperHash}`);
  const failurePath = path.join(helperDirectory, `gdrivesync-apple-vision-${helperHash}.failed.json`);
  return {
    helperDirectory,
    binaryPath,
    failurePath
  };
}

async function ensureCompiledHelper(cacheRootPath: string, helperSourcePath: string): Promise<{
  available: boolean;
  compilerAvailable: boolean;
  helperSourceExists: boolean;
  status: AppleVisionCapabilityReport["status"];
  binaryPath?: string;
}> {
  if (process.platform !== "darwin") {
    return {
      available: false,
      compilerAvailable: false,
      helperSourceExists: false,
      status: "unavailable"
    };
  }

  if (!(await pathExists(helperSourcePath))) {
    return {
      available: false,
      compilerAvailable: false,
      helperSourceExists: false,
      status: "unavailable"
    };
  }

  const compilerCommand = await resolveCompilerCommand();
  if (!compilerCommand) {
    return {
      available: false,
      compilerAvailable: false,
      helperSourceExists: true,
      status: "unavailable"
    };
  }

  const helperSource = await readFile(helperSourcePath, "utf8");
  const helperHash = sha256Text(helperSource).replace(/^sha256:/, "");
  const helperPaths = buildHelperPaths(cacheRootPath, helperHash);
  await mkdir(helperPaths.helperDirectory, { recursive: true });

  if (await pathExists(helperPaths.binaryPath)) {
    return {
      available: true,
      compilerAvailable: true,
      helperSourceExists: true,
      status: "compiled",
      binaryPath: helperPaths.binaryPath
    };
  }

  if (await pathExists(helperPaths.failurePath)) {
    try {
      const rawFailure = await readFile(helperPaths.failurePath, "utf8");
      const parsedFailure = JSON.parse(rawFailure) as Partial<CompileFailureRecord>;
      const failedAt = typeof parsedFailure.failedAt === "string" ? Date.parse(parsedFailure.failedAt) : NaN;
      if (Number.isFinite(failedAt) && Date.now() - failedAt < COMPILE_FAILURE_RETRY_MS) {
        return {
          available: false,
          compilerAvailable: true,
          helperSourceExists: true,
          status: "compile-failed"
        };
      }
    } catch {
      // Ignore unreadable failure sentinels and retry compilation below.
    }

    try {
      await unlink(helperPaths.failurePath);
    } catch {
      // Best effort only.
    }
  }

  try {
    await execFileAsync(compilerCommand, resolveCompileArguments(helperSourcePath, helperPaths.binaryPath, compilerCommand), {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    });
    return {
      available: true,
      compilerAvailable: true,
      helperSourceExists: true,
      status: "compiled",
      binaryPath: helperPaths.binaryPath
    };
  } catch (error) {
    const failureRecord: CompileFailureRecord = {
      version: 1,
      helperHash,
      failedAt: new Date().toISOString(),
      compilerCommand,
      message: error instanceof Error ? error.message : String(error)
    };
    await writeFile(helperPaths.failurePath, `${JSON.stringify(failureRecord, null, 2)}\n`, "utf8");
    return {
      available: false,
      compilerAvailable: true,
      helperSourceExists: true,
      status: "compile-failed"
    };
  }
}

export async function inspectAppleVisionCapability(
  cacheRootPath: string,
  helperSourcePath: string
): Promise<AppleVisionCapabilityReport> {
  const compiledHelper = await ensureCompiledHelper(cacheRootPath, helperSourcePath);
  return {
    available: compiledHelper.available,
    compilerAvailable: compiledHelper.compilerAvailable,
    helperSourceExists: compiledHelper.helperSourceExists,
    status: compiledHelper.status,
    cacheRootPath,
    binaryPath: compiledHelper.binaryPath
  };
}

export function parseAppleVisionOutput(rawValue: string): AppleVisionOcrResult[] {
  const parsed = JSON.parse(rawValue) as Array<Record<string, unknown>>;
  if (!Array.isArray(parsed)) {
    throw new Error("Apple Vision helper returned malformed JSON.");
  }

  return parsed.map((entry) => ({
    path: typeof entry.path === "string" ? entry.path : "",
    text: typeof entry.text === "string" ? entry.text : undefined,
    error: typeof entry.error === "string" ? entry.error : undefined
  }));
}

export async function runAppleVisionOcr(
  imagePaths: string[],
  cacheRootPath: string,
  helperSourcePath: string
): Promise<Map<string, AppleVisionOcrResult>> {
  const compiledHelper = await ensureCompiledHelper(cacheRootPath, helperSourcePath);
  if (!compiledHelper.available || !compiledHelper.binaryPath) {
    return new Map();
  }

  const { stdout } = await execFileAsync(compiledHelper.binaryPath, imagePaths, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  const results = parseAppleVisionOutput(stdout);
  return new Map(results.filter((result) => result.path).map((result) => [path.resolve(result.path), result]));
}

export function resolveDefaultCliCacheRoot(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "GDriveSync");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "GDriveSync", "Cache");
  }

  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "gdrivesync");
}
