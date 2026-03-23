#!/usr/bin/env node

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { DriveClient } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { loadDevelopmentEnv, resolveCliGoogleConfig } from "./runtimeConfig";
import { getSupportedSourceMimeTypes, resolveSyncProfileForMimeType } from "./syncProfiles";
import { FileTokenStore } from "./tokenStores";
import { parseGoogleDocInput } from "./utils/docUrl";
import { convertDocxToMarkdown } from "./docxConverter";
import { parseWorkbookToCsvOutput } from "./workbookCsv";

function printUsage(): void {
  process.stdout.write(`Usage:
  gdrivesync sign-in
  gdrivesync sign-out
  gdrivesync inspect <google-file-url-or-id>
  gdrivesync metadata <google-file-url-or-id>
  gdrivesync export <google-file-url-or-id> [output-path] [--json]
`);
}

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

async function main(): Promise<void> {
  await loadDevelopmentEnv(process.cwd());

  const rawArgs = process.argv.slice(2);
  const jsonOutput = rawArgs.includes("--json");
  const args = rawArgs.filter((arg) => arg !== "--json");
  const [command, ...commandArgs] = args;
  if (!command) {
    printUsage();
    return;
  }

  const authManager = new GoogleAuthManager(
    new FileTokenStore(path.join(os.homedir(), ".gdrivesync-dev-session.json")),
    resolveCliGoogleConfig,
    openExternalUrl
  );
  const driveClient = new DriveClient();

  if (command === "sign-in") {
    await authManager.signIn();
    process.stdout.write("Signed in.\n");
    return;
  }

  if (command === "sign-out") {
    await authManager.signOut();
    process.stdout.write("Signed out.\n");
    return;
  }

  const rawInput = commandArgs[0];
  const parsedInput = rawInput ? parseGoogleDocInput(rawInput) : undefined;
  if (!parsedInput) {
    throw new Error("Pass a Google Docs, Sheets, Drive, DOCX, or XLSX file URL or raw file ID.");
  }

  const accessToken = await authManager.getAccessToken();
  const metadata = await driveClient.getFileMetadata(accessToken, {
    fileId: parsedInput.fileId,
    resourceKey: parsedInput.resourceKey,
    expectedMimeTypes: getSupportedSourceMimeTypes(),
    sourceTypeLabel: "supported Google file"
  });
  const syncProfile = resolveSyncProfileForMimeType(metadata.mimeType);
  if (!syncProfile) {
    throw new Error(`Unsupported Google file type: ${metadata.mimeType}`);
  }

  if (command === "metadata" || command === "inspect") {
    process.stdout.write(
      `${JSON.stringify(
        {
          fileId: metadata.id,
          title: metadata.name,
          sourceMimeType: metadata.mimeType,
          sourceUrl: metadata.webViewLink || syncProfile.buildSourceUrl(metadata.id),
          profileId: syncProfile.id,
          sourceTypeLabel: syncProfile.sourceTypeLabel,
          targetFamily: syncProfile.targetFamily,
          targetFileExtension: syncProfile.targetFileExtension,
          retrievalMode: syncProfile.retrievalMode
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (command === "export") {
    const outputPath = commandArgs[1];
    if (syncProfile.targetFamily === "csv") {
      const workbookBytes =
        syncProfile.retrievalMode === "drive-export-xlsx"
          ? await driveClient.exportFile(accessToken, parsedInput.fileId, syncProfile.exportMimeType, parsedInput.resourceKey)
          : await driveClient.downloadFile(accessToken, parsedInput.fileId, parsedInput.resourceKey);
      const workbookOutput = parseWorkbookToCsvOutput(outputPath || `${metadata.name}.csv`, workbookBytes);
      if (!outputPath) {
        if (workbookOutput.outputKind === "directory") {
          throw new Error("Pass an output path when exporting a spreadsheet with multiple visible worksheets.");
        }

        process.stdout.write(workbookOutput.primaryFileText || "");
        return;
      }

      if (workbookOutput.outputKind === "file") {
        await writeFile(outputPath, workbookOutput.primaryFileText || "", "utf8");
        if (jsonOutput) {
          process.stdout.write(
            `${JSON.stringify(
              {
                status: "written",
                outputKind: "file",
                path: outputPath,
                visibleSheetCount: workbookOutput.visibleSheetCount
              },
              null,
              2
            )}\n`
          );
        } else {
          process.stdout.write(`Wrote ${outputPath}\n`);
        }
        return;
      }

      const outputDirectory = path.dirname(outputPath);
      const writtenFiles: string[] = [];
      for (const generatedFile of workbookOutput.generatedFiles) {
        const absolutePath = path.join(outputDirectory, ...generatedFile.relativePath.split("/"));
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, Buffer.from(generatedFile.bytes));
        writtenFiles.push(absolutePath);
      }
      const generatedDirectory = path.join(outputDirectory, path.parse(outputPath).name);
      if (jsonOutput) {
        process.stdout.write(
          `${JSON.stringify(
            {
              status: "written",
              outputKind: "directory",
              path: generatedDirectory,
              visibleSheetCount: workbookOutput.visibleSheetCount,
              writtenFiles
            },
            null,
            2
          )}\n`
        );
      } else {
        process.stdout.write(`Wrote ${generatedDirectory}\n`);
      }
      return;
    }

    const markdown =
      syncProfile.retrievalMode === "drive-download-docx"
        ? await convertDocxToMarkdown(await driveClient.downloadFile(accessToken, parsedInput.fileId, parsedInput.resourceKey))
        : await driveClient.exportText(accessToken, parsedInput.fileId, syncProfile.exportMimeType, parsedInput.resourceKey);
    if (outputPath) {
      await writeFile(outputPath, markdown, "utf8");
      if (jsonOutput) {
        process.stdout.write(
          `${JSON.stringify(
            {
              status: "written",
              outputKind: "file",
              path: outputPath
            },
            null,
            2
          )}\n`
        );
      } else {
        process.stdout.write(`Wrote ${outputPath}\n`);
      }
      return;
    }

    process.stdout.write(markdown);
    return;
  }

  printUsage();
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
