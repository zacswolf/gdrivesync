import { describe, expect, it } from "vitest";

import { inspectManifestValue, normalizeManifest, parseManifestText } from "../../src/manifestSchema";
import { CorruptStateError } from "../../src/stateErrors";

describe("normalizeManifest", () => {
  it("keeps valid current-schema entries", () => {
    const manifest = normalizeManifest({
      version: 4,
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
          syncOnOpen: true,
          generatedFiles: [
            {
              relativePath: "docs/spec.assets/image1.png",
              contentHash: "sha256:abc123"
            }
          ]
        }
      }
    });

    expect(Object.keys(manifest.files)).toEqual(["docs/spec.md"]);
    expect(manifest.version).toBe(4);
    expect(manifest.files["docs/spec.md"]?.profileId).toBe("google-doc-markdown");
    expect(manifest.files["docs/spec.md"]?.fileId).toBe("abc123");
    expect(manifest.files["docs/spec.md"]?.sourceMimeType).toBe("application/vnd.google-apps.document");
    expect(manifest.files["docs/spec.md"]?.exportMimeType).toBe("text/markdown");
    expect(manifest.files["docs/spec.md"]?.localFormat).toBe("markdown");
    expect(manifest.files["docs/spec.md"]?.outputKind).toBe("file");
    expect(manifest.files["docs/spec.md"]?.syncOnOpen).toBe(true);
    expect(manifest.files["docs/spec.md"]?.generatedFiles).toEqual([
      {
        relativePath: "docs/spec.assets/image1.png",
        contentHash: "sha256:abc123"
      }
    ]);
  });

  it("drops invalid current-schema entries during normalization", () => {
    const manifest = normalizeManifest({
      version: 4,
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
          syncOnOpen: false
        },
        "docs/bad.md": {
          profileId: "google-doc-markdown",
          title: "Missing file ID"
        }
      }
    });

    expect(Object.keys(manifest.files)).toEqual(["docs/spec.md"]);
  });

  it("reports dropped invalid entries during manifest inspection", () => {
    const inspection = inspectManifestValue({
      version: 4,
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
          syncOnOpen: false
        },
        "docs/bad.md": {
          profileId: "google-doc-markdown",
          title: "Missing file ID"
        }
      }
    });

    expect(inspection.rawEntryCount).toBe(2);
    expect(inspection.normalizedEntryCount).toBe(1);
    expect(inspection.droppedEntryCount).toBe(1);
  });

  it("rejects unsupported manifest versions", () => {
    expect(() =>
      parseManifestText(
        JSON.stringify({
          version: 3,
          files: {}
        }),
        "/tmp/.gdrivesync.json"
      )
    ).toThrowError(CorruptStateError);
  });

  it("throws a corruption error for invalid manifest JSON", () => {
    expect(() => parseManifestText("{not-json", "/tmp/.gdrivesync.json")).toThrowError(CorruptStateError);
  });
});
