import { describe, expect, it } from "vitest";

import { normalizeManifest } from "../../src/manifestSchema";

describe("normalizeManifest", () => {
  it("drops invalid entries and keeps valid linked files", () => {
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
    expect(manifest.files["docs/spec.md"]?.syncOnOpen).toBe(true);
  });
});
