import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CliManifestStore } from "../../src/cliManifestStore";
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

describe("CliManifestStore", () => {
  let rootPath: string;

  beforeEach(async () => {
    rootPath = await mkdtemp(path.join(os.tmpdir(), "gdrivesync-cli-manifest-"));
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  it("writes the manifest atomically", async () => {
    const store = new CliManifestStore(rootPath);
    await store.linkFile(path.join(rootPath, "notes", "spec.md"), createEntry("abc123", "Spec"));

    const manifestPath = store.getManifestPath();
    const rawValue = await readFile(manifestPath, "utf8");
    expect(JSON.parse(rawValue)).toMatchObject({
      version: 4
    });

    const siblings = await readdir(rootPath);
    expect(siblings.filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("preserves concurrent updates from two store instances", async () => {
    const firstStore = new CliManifestStore(rootPath);
    const secondStore = new CliManifestStore(rootPath);
    const firstPath = path.join(rootPath, "notes", "first.md");
    const secondPath = path.join(rootPath, "notes", "second.md");

    await firstStore.linkFile(firstPath, createEntry("first", "First"));
    await firstStore.linkFile(secondPath, createEntry("second", "Second"));

    const originalReadManifest = firstStore.readManifest.bind(firstStore);
    firstStore.readManifest = async () => {
      const manifest = await originalReadManifest();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return manifest;
    };

    await Promise.all([
      firstStore.updateLinkedFile(firstPath, (entry) => ({ ...entry, title: "First updated" })),
      secondStore.updateLinkedFile(secondPath, (entry) => ({ ...entry, title: "Second updated" }))
    ]);

    const manifest = await firstStore.readManifest();
    expect(manifest.files["notes/first.md"]?.title).toBe("First updated");
    expect(manifest.files["notes/second.md"]?.title).toBe("Second updated");
  });

  it("preserves unrelated entries during concurrent unlink and link operations", async () => {
    const firstStore = new CliManifestStore(rootPath);
    const secondStore = new CliManifestStore(rootPath);
    const keepPath = path.join(rootPath, "notes", "keep.md");
    const removePath = path.join(rootPath, "notes", "remove.md");
    const addPath = path.join(rootPath, "notes", "add.md");

    await firstStore.linkFile(keepPath, createEntry("keep", "Keep"));
    await firstStore.linkFile(removePath, createEntry("remove", "Remove"));

    const originalReadManifest = firstStore.readManifest.bind(firstStore);
    firstStore.readManifest = async () => {
      const manifest = await originalReadManifest();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return manifest;
    };

    await Promise.all([
      firstStore.unlinkFile(removePath),
      secondStore.linkFile(addPath, createEntry("add", "Add"))
    ]);

    const manifest = await firstStore.readManifest();
    expect(Object.keys(manifest.files)).toEqual(["notes/add.md", "notes/keep.md"]);
  });
});
