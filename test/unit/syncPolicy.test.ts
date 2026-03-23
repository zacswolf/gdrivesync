import { describe, expect, it } from "vitest";

import { needsOverwriteConfirmation } from "../../src/overwritePolicy";

describe("needsOverwriteConfirmation", () => {
  it("prompts when the editor is dirty", () => {
    expect(needsOverwriteConfirmation({ fileExists: true, isDirty: true, currentHash: "sha256:1" }, "sha256:1")).toBe(true);
  });

  it("prompts for an existing untracked file", () => {
    expect(needsOverwriteConfirmation({ fileExists: true, isDirty: false, currentHash: "sha256:1" })).toBe(true);
  });

  it("does not prompt when the file matches the last synced hash", () => {
    expect(
      needsOverwriteConfirmation({ fileExists: true, isDirty: false, currentHash: "sha256:1" }, "sha256:1")
    ).toBe(false);
  });
});
