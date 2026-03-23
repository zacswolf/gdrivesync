import assert from "node:assert/strict";

import * as vscode from "vscode";

suite("GDriveSync extension", () => {
  test("registers the main commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    const expectedCommands = [
      "gdocSync.signIn",
      "gdocSync.signOut",
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
