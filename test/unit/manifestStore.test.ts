import { describe, expect, it } from "vitest";

import { normalizeManifest } from "../../src/manifestSchema";
import { getDefaultSyncProfile } from "../../src/syncProfiles";

describe("normalizeManifest", () => {
  it("migrates legacy doc links into the generic file schema", () => {
    const manifest = normalizeManifest({
      version: 1,
      files: {
        "docs/spec.md": {
          docId: "abc123",
          sourceUrl: "https://docs.google.com/document/d/abc123/edit",
          title: "Spec",
          syncOnOpen: true
        },
        "docs/invalid.md": {
          docId: 42
        }
      }
    });

    expect(Object.keys(manifest.files)).toEqual(["docs/spec.md"]);
    expect(manifest.version).toBe(3);
    expect(manifest.files["docs/spec.md"]?.profileId).toBe(getDefaultSyncProfile().id);
    expect(manifest.files["docs/spec.md"]?.fileId).toBe("abc123");
    expect(manifest.files["docs/spec.md"]?.sourceMimeType).toBe(getDefaultSyncProfile().sourceMimeType);
    expect(manifest.files["docs/spec.md"]?.exportMimeType).toBe(getDefaultSyncProfile().exportMimeType);
    expect(manifest.files["docs/spec.md"]?.localFormat).toBe(getDefaultSyncProfile().localFormat);
    expect(manifest.files["docs/spec.md"]?.outputKind).toBe("file");
    expect(manifest.files["docs/spec.md"]?.syncOnOpen).toBe(true);
    expect(manifest.files["docs/spec.md"]?.generatedFiles).toBeUndefined();
  });

  it("keeps valid generic entries", () => {
    const manifest = normalizeManifest({
      version: 3,
      files: {
        "docs/spec.md": {
          profileId: "google-doc-markdown",
          fileId: "abc123",
          sourceUrl: "https://docs.google.com/document/d/abc123/edit",
          sourceMimeType: "application/vnd.google-apps.document",
          exportMimeType: "text/markdown",
          localFormat: "markdown",
          outputKind: "file",
          title: "Spec",
          syncOnOpen: false,
          generatedFiles: [
            {
              relativePath: "docs/spec.assets/image1.png",
              contentHash: "sha256:abc123"
            }
          ],
          generatedFilePaths: ["docs/spec.assets/image1.png"]
        }
      }
    });

    expect(manifest.files["docs/spec.md"]?.fileId).toBe("abc123");
    expect(manifest.files["docs/spec.md"]?.syncOnOpen).toBe(false);
    expect(manifest.files["docs/spec.md"]?.generatedFiles).toEqual([
      {
        relativePath: "docs/spec.assets/image1.png",
        contentHash: "sha256:abc123"
      }
    ]);
    expect(manifest.files["docs/spec.md"]?.generatedFilePaths).toEqual(["docs/spec.assets/image1.png"]);
  });

  it("upgrades legacy generatedAssetPaths into generated asset records", () => {
    const manifest = normalizeManifest({
      version: 2,
      files: {
        "docs/spec.md": {
          profileId: "google-doc-markdown",
          fileId: "abc123",
          sourceUrl: "https://docs.google.com/document/d/abc123/edit",
          title: "Spec",
          syncOnOpen: false,
          generatedAssetPaths: ["docs/spec.assets/image1.png"]
        }
      }
    });

    expect(manifest.files["docs/spec.md"]?.generatedFiles).toEqual([
      {
        relativePath: "docs/spec.assets/image1.png"
      }
    ]);
  });
});
