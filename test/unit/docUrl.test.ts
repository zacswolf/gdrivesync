import { describe, expect, it } from "vitest";

import { buildGoogleDocUrl, parseGoogleDocInput } from "../../src/utils/docUrl";

describe("parseGoogleDocInput", () => {
  it("parses a raw document ID", () => {
    expect(parseGoogleDocInput("1AbCdEfGhIjKlMnOpQrStUvWxYz123456789")).toEqual({
      docId: "1AbCdEfGhIjKlMnOpQrStUvWxYz123456789",
      sourceUrl: buildGoogleDocUrl("1AbCdEfGhIjKlMnOpQrStUvWxYz123456789")
    });
  });

  it("parses a Google Docs URL with a resource key", () => {
    expect(
      parseGoogleDocInput(
        "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456789/edit?resourcekey=0-abc123"
      )
    ).toEqual({
      docId: "1AbCdEfGhIjKlMnOpQrStUvWxYz123456789",
      sourceUrl: buildGoogleDocUrl("1AbCdEfGhIjKlMnOpQrStUvWxYz123456789"),
      resourceKey: "0-abc123"
    });
  });

  it("rejects non-doc URLs", () => {
    expect(parseGoogleDocInput("https://example.com")).toBeUndefined();
  });
});
