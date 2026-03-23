import { describe, expect, it } from "vitest";

import {
  buildGoogleDocUrl,
  buildGoogleDriveFileUrl,
  buildGoogleSheetUrl,
  buildGoogleSlidesUrl,
  parseGoogleDocInput
} from "../../src/utils/docUrl";

describe("parseGoogleDocInput", () => {
  it("parses a raw file ID", () => {
    expect(parseGoogleDocInput("1AbCdEfGhIjKlMnOpQrStUvWxYz123456789")).toEqual({
      fileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz123456789",
      sourceUrl: buildGoogleDriveFileUrl("1AbCdEfGhIjKlMnOpQrStUvWxYz123456789")
    });
  });

  it("parses a Google Docs URL with a resource key", () => {
    expect(
      parseGoogleDocInput(
        "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456789/edit?resourcekey=0-abc123"
      )
    ).toEqual({
      fileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz123456789",
      sourceUrl: buildGoogleDocUrl("1AbCdEfGhIjKlMnOpQrStUvWxYz123456789"),
      resourceKey: "0-abc123"
    });
  });

  it("parses a Drive file URL", () => {
    expect(parseGoogleDocInput("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456789/view")).toEqual({
      fileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz123456789",
      sourceUrl: buildGoogleDriveFileUrl("1AbCdEfGhIjKlMnOpQrStUvWxYz123456789")
    });
  });

  it("parses a Drive URL with an id query parameter", () => {
    expect(parseGoogleDocInput("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWxYz123456789")).toEqual({
      fileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz123456789",
      sourceUrl: buildGoogleDriveFileUrl("1AbCdEfGhIjKlMnOpQrStUvWxYz123456789")
    });
  });

  it("parses a Google Sheets URL", () => {
    expect(parseGoogleDocInput("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456789/edit?gid=0")).toEqual({
      fileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz123456789",
      sourceUrl: buildGoogleSheetUrl("1AbCdEfGhIjKlMnOpQrStUvWxYz123456789")
    });
  });

  it("parses a Google Slides URL", () => {
    expect(parseGoogleDocInput("https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456789/edit?slide=id.p1")).toEqual({
      fileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz123456789",
      sourceUrl: buildGoogleSlidesUrl("1AbCdEfGhIjKlMnOpQrStUvWxYz123456789")
    });
  });

  it("rejects non-doc URLs", () => {
    expect(parseGoogleDocInput("https://example.com")).toBeUndefined();
  });
});
