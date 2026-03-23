import os from "node:os";
import path from "node:path";

import { DriveClient } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { loadDevelopmentEnv, resolveCliGoogleConfig } from "./runtimeConfig";
import { getSupportedSourceMimeTypes, resolveSyncProfileForMimeType } from "./syncProfiles";
import { FileTokenStore } from "./tokenStores";
import { parseGoogleDocInput } from "./utils/docUrl";
import { convertDocxToMarkdown } from "./docxConverter";

function printUsage(): void {
  process.stdout.write(`Usage:
  npm run cli -- sign-in
  npm run cli -- sign-out
  npm run cli -- metadata <google-file-url-or-id>
  npm run cli -- export <google-file-url-or-id> [output-path]
`);
}

async function main(): Promise<void> {
  await loadDevelopmentEnv(process.cwd());

  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    printUsage();
    return;
  }

  const authManager = new GoogleAuthManager(
    new FileTokenStore(path.join(os.homedir(), ".gdocsync-dev-session.json")),
    resolveCliGoogleConfig
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

  const rawInput = args[0];
  const parsedInput = rawInput ? parseGoogleDocInput(rawInput) : undefined;
  if (!parsedInput) {
    throw new Error("Pass a Google Docs, Drive, or DOCX file URL or raw file ID.");
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

  if (command === "metadata") {
    process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
    return;
  }

  if (command === "export") {
    const markdown =
      syncProfile.retrievalMode === "drive-download-docx"
        ? await convertDocxToMarkdown(await driveClient.downloadFile(accessToken, parsedInput.fileId, parsedInput.resourceKey))
        : await driveClient.exportText(accessToken, parsedInput.fileId, syncProfile.exportMimeType, parsedInput.resourceKey);
    const outputPath = args[1];
    if (outputPath) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(outputPath, markdown, "utf8");
      process.stdout.write(`Wrote ${outputPath}\n`);
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
