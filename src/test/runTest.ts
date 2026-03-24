import path from "node:path";

import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../..");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");
  const workspacePath = path.join(extensionDevelopmentPath, "test", "fixtures", "workspace");
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    version: "1.105.1",
    launchArgs: [workspacePath]
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
