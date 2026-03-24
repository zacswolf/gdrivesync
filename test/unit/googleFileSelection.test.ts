import { describe, expect, it } from "vitest";

import { PickerGrantRequiredError } from "../../src/driveClient";
import { getSyncProfilesForTargetFamily } from "../../src/syncProfiles";
import { normalizeResolvedGoogleFileSelection, shouldRecoverAccessWithPicker } from "../../src/utils/googleFileSelection";

describe("googleFileSelection", () => {
  it("normalizes canonical picker metadata into a supported selection", () => {
    const selection = normalizeResolvedGoogleFileSelection(
      {
        fileId: "slide-123",
        title: "Pitch Deck",
        sourceUrl: "https://docs.google.com/presentation/d/slide-123/edit?resourcekey=0-slide123",
        sourceMimeType: "application/vnd.google-apps.presentation"
      },
      getSyncProfilesForTargetFamily("markdown"),
      "Markdown"
    );

    expect(selection).toEqual({
      profileId: "google-slide-marp",
      fileId: "slide-123",
      title: "Pitch Deck",
      sourceUrl: "https://docs.google.com/presentation/d/slide-123/edit?resourcekey=0-slide123",
      sourceMimeType: "application/vnd.google-apps.presentation",
      resourceKey: "0-slide123"
    });
  });

  it("rejects picker selections that cannot sync to the chosen target type", () => {
    expect(() =>
      normalizeResolvedGoogleFileSelection(
        {
          fileId: "sheet-123",
          title: "Revenue",
          sourceUrl: "https://docs.google.com/spreadsheets/d/sheet-123/edit",
          sourceMimeType: "application/vnd.google-apps.spreadsheet"
        },
        getSyncProfilesForTargetFamily("markdown"),
        "Markdown"
      )
    ).toThrow("This Google file cannot sync to the selected Markdown target.");
  });

  it("recovers through picker when access failed and the pasted link had no resource key", () => {
    expect(
      shouldRecoverAccessWithPicker(
        {
          fileId: "slide-123",
          sourceUrl: "https://docs.google.com/presentation/d/slide-123/edit"
        },
        new PickerGrantRequiredError("denied", 403)
      )
    ).toBe(true);
  });

  it("does not recover through picker when the pasted link already includes a resource key", () => {
    expect(
      shouldRecoverAccessWithPicker(
        {
          fileId: "slide-123",
          sourceUrl: "https://docs.google.com/presentation/d/slide-123/edit?resourcekey=0-slide123",
          resourceKey: "0-slide123"
        },
        new PickerGrantRequiredError("denied", 403)
      )
    ).toBe(false);
  });
});
