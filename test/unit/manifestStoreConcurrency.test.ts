import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => ({
  rootPath: ""
}));

vi.mock("vscode", () => ({
  Uri: {
    file: (fsPath: string) => ({
      fsPath,
      toString: () => `file://${fsPath}`
    })
  },
  workspace: {
    getWorkspaceFolder: (fileUri: { fsPath: string }) =>
      fileUri.fsPath.startsWith(vscodeState.rootPath)
        ? {
            uri: { fsPath: vscodeState.rootPath },
            name: path.basename(vscodeState.rootPath)
          }
        : undefined,
    get workspaceFolders() {
      return [
        {
          uri: { fsPath: vscodeState.rootPath },
          name: path.basename(vscodeState.rootPath)
        }
      ];
    }
  }
}));

import { ManifestStore } from "../../src/manifestStore";

function createEntry(fileId: string, title: string) {
  return {
    profileId: "google-doc-markdown" as const,
    fileId,
    sourceUrl: `https://docs.google.com/document/d/${fileId}/edit`,
    sourceMimeType: "application/vnd.google-apps.document",
    exportMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    localFormat: "markdown",
    outputKind: "file" as const,
    title,
    syncOnOpen: false
  };
}

describe("ManifestStore concurrency", () => {
  let rootPath: string;

  beforeEach(async () => {
    rootPath = await mkdtemp(path.join(os.tmpdir(), "gdrivesync-manifest-store-"));
    vscodeState.rootPath = rootPath;
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  it("preserves concurrent updates from two store instances", async () => {
    const firstStore = new ManifestStore();
    const secondStore = new ManifestStore();
    const firstUri = { fsPath: path.join(rootPath, "notes", "first.md") } as never;
    const secondUri = { fsPath: path.join(rootPath, "notes", "second.md") } as never;

    await firstStore.linkFile(firstUri, createEntry("first", "First"));
    await firstStore.linkFile(secondUri, createEntry("second", "Second"));

    const originalReadManifest = firstStore.readManifest.bind(firstStore);
    firstStore.readManifest = async (folderPath: string) => {
      const manifest = await originalReadManifest(folderPath);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return manifest;
    };

    await Promise.all([
      firstStore.updateLinkedFile(firstUri, (entry) => ({ ...entry, title: "First updated" })),
      secondStore.updateLinkedFile(secondUri, (entry) => ({ ...entry, title: "Second updated" }))
    ]);

    const manifest = await firstStore.readManifest(rootPath);
    expect(manifest.files["notes/first.md"]?.title).toBe("First updated");
    expect(manifest.files["notes/second.md"]?.title).toBe("Second updated");
  });
});
