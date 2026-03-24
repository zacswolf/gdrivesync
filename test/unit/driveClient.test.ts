import { describe, expect, it } from "vitest";

import { DriveClient, GoogleApiError, PickerGrantRequiredError } from "../../src/driveClient";

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

  it("surfaces export size limit errors as drive API errors instead of access errors", async () => {
    const client = new DriveClient(async () =>
      mockResponse(
        {
          error: {
            code: 403,
            message: "This file is too large to be exported.",
            errors: [{ reason: "exportSizeLimitExceeded" }]
          }
        },
        { status: 403 }
      )
    );

    await expect(client.exportFile("token", "doc-1", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).rejects.toBeInstanceOf(
      GoogleApiError
    );
    await expect(client.exportFile("token", "doc-1", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).rejects.not.toBeInstanceOf(
      PickerGrantRequiredError
    );
    await expect(client.exportFile("token", "doc-1", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).rejects.toMatchObject({
      message: "This file is too large to be exported."
    });
  });

  it("downloads blob files as bytes", async () => {
    const client = new DriveClient(async () => mockResponse("Hello"));
    await expect(client.downloadFile("token", "doc-1")).resolves.toEqual(Uint8Array.from(Buffer.from("Hello")));
  });

  it("times out stalled Google Drive requests", async () => {
    const client = new DriveClient(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true }
          );
        }),
      1
    );

    await expect(client.getFileMetadata("token", { fileId: "doc-1" })).rejects.toMatchObject({
      message: "Google Drive request timed out.",
      status: 408
    });
    await expect(client.getFileMetadata("token", { fileId: "doc-1" })).rejects.toBeInstanceOf(GoogleApiError);
  });

  it("retries transient Google API failures before succeeding", async () => {
    let attempts = 0;
    const sleepCalls: number[] = [];
    const client = new DriveClient(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          return mockResponse("busy", { status: 503 });
        }

        return mockResponse({
          id: "doc-1",
          name: "Recovered",
          mimeType: "application/vnd.google-apps.document",
          version: "13"
        });
      },
      1_000,
      [5, 10],
      async (durationMs) => {
        sleepCalls.push(durationMs);
      }
    );

    await expect(client.getFileMetadata("token", { fileId: "doc-1" })).resolves.toMatchObject({
      id: "doc-1",
      version: "13"
    });
    expect(attempts).toBe(3);
    expect(sleepCalls).toEqual([5, 10]);
  });

  it("does not retry permanent Google API failures", async () => {
    let attempts = 0;
    const client = new DriveClient(
      async () => {
        attempts += 1;
        return mockResponse("forbidden", { status: 403 });
      },
      1_000,
      [5, 10],
      async () => undefined
    );

    await expect(client.getFileMetadata("token", { fileId: "doc-1" })).rejects.toBeInstanceOf(PickerGrantRequiredError);
    expect(attempts).toBe(1);
  });
});
