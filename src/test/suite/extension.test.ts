import assert from "node:assert/strict";

import * as vscode from "vscode";

suite("GDriveSync extension", () => {
  test("registers the main commands", async () => {
    const extension = vscode.extensions.getExtension("zacswolf.gdrivesync-vscode-extension");
    assert.ok(extension, "Expected the GDriveSync extension to be available in the test host.");
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    const expectedCommands = [
      "gdocSync.connectGoogleAccount",
      "gdocSync.disconnectGoogleAccount",
      "gdocSync.switchDefaultGoogleAccount",
      "gdocSync.googleAccounts",
      "gdocSync.linkCurrentFile",
      "gdocSync.importGoogleDoc",
      "gdocSync.syncCurrentFile",
      "gdocSync.syncAll",
      "gdocSync.toggleSyncOnOpen",
      "gdocSync.unlinkCurrentFile"
    ];

    for (const command of expectedCommands) {
      assert.ok(commands.includes(command), `Expected ${command} to be registered.`);
    }
  });
});
