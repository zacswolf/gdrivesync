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

    await expect(
      client.getFileMetadata("token", {
        fileId: "doc-1",
        expectedMimeTypes: ["application/vnd.google-apps.document"],
        sourceTypeLabel: "Google Doc"
      })
    ).resolves.toMatchObject({
      id: "doc-1",
      name: "Spec",
      version: "12"
    });
  });

  it("throws a picker access error for inaccessible docs", async () => {
    const client = new DriveClient(async () => mockResponse("forbidden", { status: 403 }));
    await expect(client.getFileMetadata("token", { fileId: "doc-1" })).rejects.toMatchObject({
      message: "The current Google session cannot access Google file doc-1. Share it with this account or sign in with a Google account that can read it."
    });
    await expect(client.getFileMetadata("token", { fileId: "doc-1" })).rejects.toBeInstanceOf(PickerGrantRequiredError);
  });

  it("returns the signed-in Drive user when available", async () => {
    const client = new DriveClient(async () =>
      mockResponse({
        user: {
          displayName: "Zac Wolf",
          emailAddress: "zacwolf3@gmail.com"
        }
      })
    );

    await expect(client.getCurrentUser("token")).resolves.toEqual({
      displayName: "Zac Wolf",
      emailAddress: "zacwolf3@gmail.com"
    });
  });

  it("exports text using the requested mime type", async () => {
    const client = new DriveClient(async () => mockResponse("# Hello"));
    await expect(client.exportText("token", "doc-1", "text/markdown")).resolves.toBe("# Hello");
  });

  it("exports file bytes using the requested mime type", async () => {
    const client = new DriveClient(async () => mockResponse("Hello"));
    await expect(client.exportFile("token", "doc-1", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).resolves.toEqual(
      Uint8Array.from(Buffer.from("Hello"))
    );
  });

  it("downloads blob files as bytes", async () => {
    const client = new DriveClient(async () => mockResponse("Hello"));
    await expect(client.downloadFile("token", "doc-1")).resolves.toEqual(Uint8Array.from(Buffer.from("Hello")));
  });
});
