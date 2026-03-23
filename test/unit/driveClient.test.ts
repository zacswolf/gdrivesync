import { describe, expect, it } from "vitest";

import { DriveClient, PickerGrantRequiredError } from "../../src/driveClient";

function mockResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": typeof body === "string" ? "text/plain" : "application/json"
    },
    ...init
  });
}

describe("DriveClient", () => {
  it("returns validated metadata for Google Docs", async () => {
    const client = new DriveClient(async () =>
      mockResponse({
        id: "doc-1",
        name: "Spec",
        mimeType: "application/vnd.google-apps.document",
        version: "12",
        webViewLink: "https://docs.google.com/document/d/doc-1/edit"
      })
    );

    await expect(client.getFileMetadata("token", "doc-1")).resolves.toMatchObject({
      id: "doc-1",
      name: "Spec",
      version: "12"
    });
  });

  it("throws a picker access error for inaccessible docs", async () => {
    const client = new DriveClient(async () => mockResponse("forbidden", { status: 403 }));
    await expect(client.getFileMetadata("token", "doc-1")).rejects.toBeInstanceOf(PickerGrantRequiredError);
  });

  it("exports markdown text", async () => {
    const client = new DriveClient(async () => mockResponse("# Hello"));
    await expect(client.exportMarkdown("token", "doc-1")).resolves.toBe("# Hello");
  });
});
