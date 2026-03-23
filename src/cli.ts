import os from "node:os";
import path from "node:path";

import { DriveClient } from "./driveClient";
import { GoogleAuthManager } from "./googleAuth";
import { resolveCliGoogleConfig } from "./runtimeConfig";
import { FileTokenStore } from "./tokenStores";
import { parseGoogleDocInput } from "./utils/docUrl";

function printUsage(): void {
  process.stdout.write(`Usage:
  npm run cli -- sign-in
  npm run cli -- sign-out
  npm run cli -- metadata <google-doc-url-or-id>
  npm run cli -- export <google-doc-url-or-id> [output-path]
`);
}

async function main(): Promise<void> {
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
    throw new Error("Pass a Google Docs URL or raw doc ID.");
  }

  const accessToken = await authManager.getAccessToken();
  if (command === "metadata") {
    const metadata = await driveClient.getFileMetadata(accessToken, parsedInput.docId, parsedInput.resourceKey);
    process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
    return;
  }

  if (command === "export") {
    const markdown = await driveClient.exportMarkdown(accessToken, parsedInput.docId, parsedInput.resourceKey);
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
