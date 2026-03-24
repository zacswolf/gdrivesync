import { describe, expect, it } from "vitest";

import { HttpCloudImageInferenceClient } from "../../src/cloudImageProviders";

describe("HttpCloudImageInferenceClient", () => {
  it("surfaces timeouts during provider health checks", async () => {
    const client = new HttpCloudImageInferenceClient(
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

    await expect(client.testProvider("openai", "key", "model")).rejects.toThrow("OpenAI test request timed out.");
  });

  it("reports timeouts as enrichment failures without crashing the batch", async () => {
    const client = new HttpCloudImageInferenceClient(
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

    const result = await client.enrichImages("openai", "key", "model", [
      {
        currentAltText: "image1",
        asset: {
          relativePath: "deck.assets/image1.png",
          bytes: Uint8Array.from([1, 2, 3]),
          mimeType: "image/png",
          contentHash: "sha256:test"
        }
      }
    ]);

    expect(result.results.size).toBe(0);
    expect(result.failureMessages).toContain("OpenAI image enrichment request timed out.");
  });
});
