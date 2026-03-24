import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appleVisionMocks = vi.hoisted(() => ({
  inspectAppleVisionCapability: vi.fn(),
  runAppleVisionOcr: vi.fn()
}));

const tesseractMocks = vi.hoisted(() => ({
  inspectTesseractCapability: vi.fn(),
  runTesseractOcr: vi.fn()
}));

vi.mock("../../src/appleVisionOcr", () => appleVisionMocks);
vi.mock("../../src/tesseractOcr", () => tesseractMocks);

import {
  deriveAltText,
  findEligibleImageReferences,
  ImageEnrichmentService,
  isGenericImageAltText,
  normalizeOcrText,
  shouldPromptForImageEnrichment
} from "../../src/imageEnrichment";
import { CloudImageInferenceClient, CloudImageKeyResolver } from "../../src/cloudImageProviders";
import { GeneratedFilePayload } from "../../src/types";

function buildTestPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

function buildAsset(relativePath: string, contentHash: string): GeneratedFilePayload {
  return {
    relativePath,
    bytes: buildTestPng(1200, 628),
    mimeType: "image/png",
    contentHash
  };
}

describe("image enrichment helpers", () => {
  it("detects generic image alt text", () => {
    expect(isGenericImageAltText("")).toBe(true);
    expect(isGenericImageAltText("image1")).toBe(true);
    expect(isGenericImageAltText("Slide 3 image 2")).toBe(true);
    expect(isGenericImageAltText("BondiBoost")).toBe(false);
    expect(isGenericImageAltText("blue-hat-process")).toBe(false);
    expect(isGenericImageAltText("Comparison chart showing weekly revenue")).toBe(false);
  });

  it("normalizes OCR text and derives alt text", () => {
    const normalized = normalizeOcrText("HAIR BURST\n\nDrugstore   Multivitamin");
    expect(normalized).toBe("HAIR BURST Drugstore Multivitamin");
    expect(deriveAltText(normalized)).toBe("HAIR BURST Drugstore Multivitamin");
  });

  it("only prompts when prompt mode has eligible images and the sync is not on open", () => {
    expect(shouldPromptForImageEnrichment("prompt", "manual", 1)).toBe(true);
    expect(shouldPromptForImageEnrichment("prompt", "open", 1)).toBe(false);
    expect(shouldPromptForImageEnrichment("prompt", "manual", 0)).toBe(false);
    expect(shouldPromptForImageEnrichment("local", "manual", 3)).toBe(false);
  });

  it("finds only eligible asset-backed image references", () => {
    const markdown = [
      "![Slide 1 image 1](./deck.assets/image1.png)",
      "![Meaningful alt text](./deck.assets/image2.png)"
    ].join("\n");
    const candidates = findEligibleImageReferences(
      markdown,
      [
        buildAsset("deck.assets/image1.png", "sha256:111"),
        buildAsset("deck.assets/image2.png", "sha256:222")
      ],
      { onlyWhenAltGeneric: true }
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.normalizedImagePath).toBe("deck.assets/image1.png");
  });

  it("finds eligible inline data-uri image references for stdout-style exports", () => {
    const markdown = "![image1](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAABLAAAAJ0)";
    const candidates = findEligibleImageReferences(markdown, [], { onlyWhenAltGeneric: true });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.normalizedImagePath.startsWith("data:image/png;base64,")).toBe(true);
  });
});

describe("ImageEnrichmentService", () => {
  let cacheRootPath: string;

  beforeEach(async () => {
    cacheRootPath = await mkdtemp(path.join(os.tmpdir(), "gdrivesync-image-enrichment-"));
    appleVisionMocks.inspectAppleVisionCapability.mockReset();
    appleVisionMocks.runAppleVisionOcr.mockReset();
    tesseractMocks.inspectTesseractCapability.mockReset();
    tesseractMocks.runTesseractOcr.mockReset();
  });

  afterEach(async () => {
    await rm(cacheRootPath, { recursive: true, force: true });
  });

  it("rewrites generic alt text and appends OCR comments", async () => {
    appleVisionMocks.inspectAppleVisionCapability.mockResolvedValue({
      available: true,
      compilerAvailable: true,
      helperSourceExists: true,
      status: "compiled",
      cacheRootPath,
      binaryPath: "/tmp/apple-vision"
    });
    appleVisionMocks.runAppleVisionOcr.mockImplementation(async (imagePaths: string[]) => {
      const map = new Map<string, { path: string; text: string }>();
      for (const imagePath of imagePaths) {
        map.set(path.resolve(imagePath), {
          path: path.resolve(imagePath),
          text: "Comparison graphic Hairburst versus drugstore multivitamin"
        });
      }
      return map;
    });
    tesseractMocks.inspectTesseractCapability.mockResolvedValue({ available: false });

    const service = new ImageEnrichmentService(cacheRootPath, "/tmp/appleVisionOcr.swift");
    const result = await service.enrichMarkdown(
      "![Slide 1 image 1](./deck.assets/image1.png)",
      [buildAsset("deck.assets/image1.png", "sha256:1234")],
      {
        mode: "local",
        provider: "auto",
        cloudProvider: "openai",
        maxImagesPerRun: 25,
        store: "alt-plus-comment",
        onlyWhenAltGeneric: true
      }
    );

    expect(result.markdown).toContain("![Comparison graphic Hairburst versus drugstore multivitamin](./deck.assets/image1.png)");
    expect(result.markdown).toContain("<!-- gdrivesync:image-meta");
    expect(result.stats.enrichedImageCount).toBe(1);
    expect(result.stats.commentCount).toBe(1);
  });

  it("falls back to tesseract when apple vision is unavailable", async () => {
    appleVisionMocks.inspectAppleVisionCapability.mockResolvedValue({
      available: false,
      compilerAvailable: false,
      helperSourceExists: true,
      status: "unavailable",
      cacheRootPath
    });
    tesseractMocks.inspectTesseractCapability.mockResolvedValue({
      available: true,
      path: "/usr/bin/tesseract"
    });
    tesseractMocks.runTesseractOcr.mockImplementation(async (imagePaths: string[]) => {
      const map = new Map<string, { path: string; text: string }>();
      for (const imagePath of imagePaths) {
        map.set(path.resolve(imagePath), {
          path: path.resolve(imagePath),
          text: "Creative strategy agency"
        });
      }
      return map;
    });

    const service = new ImageEnrichmentService(cacheRootPath, "/tmp/appleVisionOcr.swift");
    const result = await service.enrichMarkdown(
      "![image](./deck.assets/image1.png)",
      [buildAsset("deck.assets/image1.png", "sha256:aaaa")],
      {
        mode: "local",
        provider: "auto",
        cloudProvider: "openai",
        maxImagesPerRun: 25,
        store: "alt-only",
        onlyWhenAltGeneric: true
      }
    );

    expect(result.markdown).toContain("![Creative strategy agency](./deck.assets/image1.png)");
    expect(result.stats.provider).toBe("tesseract");
  });

  it("reuses cached OCR results for unchanged images", async () => {
    appleVisionMocks.inspectAppleVisionCapability.mockResolvedValue({
      available: true,
      compilerAvailable: true,
      helperSourceExists: true,
      status: "compiled",
      cacheRootPath,
      binaryPath: "/tmp/apple-vision"
    });
    appleVisionMocks.runAppleVisionOcr.mockImplementation(async (imagePaths: string[]) => {
      const map = new Map<string, { path: string; text: string }>();
      for (const imagePath of imagePaths) {
        map.set(path.resolve(imagePath), {
          path: path.resolve(imagePath),
          text: "Get paid fast"
        });
      }
      return map;
    });
    tesseractMocks.inspectTesseractCapability.mockResolvedValue({ available: false });

    const service = new ImageEnrichmentService(cacheRootPath, "/tmp/appleVisionOcr.swift");
    const settings = {
      mode: "local" as const,
      provider: "auto" as const,
      cloudProvider: "openai" as const,
      maxImagesPerRun: 25,
      store: "alt-plus-comment" as const,
      onlyWhenAltGeneric: true
    };

    await service.enrichMarkdown("![image](./deck.assets/image1.png)", [buildAsset("deck.assets/image1.png", "sha256:cache")], settings);
    const secondRun = await service.enrichMarkdown(
      "![image](./deck.assets/image1.png)",
      [buildAsset("deck.assets/image1.png", "sha256:cache")],
      settings
    );

    expect(appleVisionMocks.runAppleVisionOcr).toHaveBeenCalledTimes(1);
    expect(secondRun.stats.cacheHitCount).toBe(1);
  });

  it("supports cloud-only image enrichment with OpenAI-style metadata comments", async () => {
    appleVisionMocks.inspectAppleVisionCapability.mockResolvedValue({
      available: false,
      compilerAvailable: false,
      helperSourceExists: true,
      status: "unavailable",
      cacheRootPath
    });
    tesseractMocks.inspectTesseractCapability.mockResolvedValue({ available: false });

    const cloudKeyResolver: CloudImageKeyResolver = {
      resolve: vi.fn().mockResolvedValue({
        provider: "openai",
        apiKey: "test-key",
        source: "environment"
      })
    };
    const cloudClient: CloudImageInferenceClient = {
      enrichImages: vi.fn().mockResolvedValue({
        results: new Map([
          [
            "sha256:cloud",
            {
              contentHash: "sha256:cloud",
              useful: true,
              altText: "Screenshot of a product analytics dashboard",
              detail: "Shows a dashboard with charts, sidebar navigation, and KPI summary cards."
            }
          ]
        ]),
        failureMessages: []
      }),
      testProvider: vi.fn()
    };

    const service = new ImageEnrichmentService(cacheRootPath, "/tmp/appleVisionOcr.swift", cloudKeyResolver, cloudClient);
    const result = await service.enrichMarkdown(
      "![image](./deck.assets/image1.png)",
      [buildAsset("deck.assets/image1.png", "sha256:cloud")],
      {
        mode: "cloud",
        provider: "auto",
        cloudProvider: "openai",
        maxImagesPerRun: 25,
        store: "alt-plus-comment",
        onlyWhenAltGeneric: true
      }
    );

    expect(result.markdown).toContain("![Screenshot of a product analytics dashboard](./deck.assets/image1.png)");
    expect(result.markdown).toContain("\"source\":\"openai\"");
    expect(result.markdown).toContain("\"model\":\"gpt-5.4-nano\"");
    expect(result.markdown).toContain("\"detail\":\"Shows a dashboard with charts, sidebar navigation, and KPI summary cards.\"");
    expect(result.stats.cloudSentCount).toBe(1);
    expect(result.stats.providerLabel).toBe("OpenAI (gpt-5.4-nano)");
  });

  it("uses cloud fallback in hybrid mode when local OCR is not useful", async () => {
    appleVisionMocks.inspectAppleVisionCapability.mockResolvedValue({
      available: true,
      compilerAvailable: true,
      helperSourceExists: true,
      status: "compiled",
      cacheRootPath,
      binaryPath: "/tmp/apple-vision"
    });
    appleVisionMocks.runAppleVisionOcr.mockImplementation(async (imagePaths: string[]) => {
      const map = new Map<string, { path: string; text: string }>();
      for (const imagePath of imagePaths) {
        map.set(path.resolve(imagePath), {
          path: path.resolve(imagePath),
          text: "x"
        });
      }
      return map;
    });
    tesseractMocks.inspectTesseractCapability.mockResolvedValue({ available: false });

    const cloudKeyResolver: CloudImageKeyResolver = {
      resolve: vi.fn().mockResolvedValue({
        provider: "anthropic",
        apiKey: "anthropic-key",
        source: "keychain"
      })
    };
    const cloudClient: CloudImageInferenceClient = {
      enrichImages: vi.fn().mockResolvedValue({
        results: new Map([
          [
            "sha256:hybrid",
            {
              contentHash: "sha256:hybrid",
              useful: true,
              altText: "Comparison card listing agency service tiers",
              detail: "Shows side-by-side pricing tiers with feature bullets and highlighted callouts."
            }
          ]
        ]),
        failureMessages: []
      }),
      testProvider: vi.fn()
    };

    const service = new ImageEnrichmentService(cacheRootPath, "/tmp/appleVisionOcr.swift", cloudKeyResolver, cloudClient);
    const result = await service.enrichMarkdown(
      "![Slide 1 image 1](./deck.assets/image1.png)",
      [buildAsset("deck.assets/image1.png", "sha256:hybrid")],
      {
        mode: "hybrid",
        provider: "auto",
        cloudProvider: "anthropic",
        maxImagesPerRun: 25,
        store: "alt-plus-comment",
        onlyWhenAltGeneric: true
      }
    );

    expect(result.markdown).toContain("![Comparison card listing agency service tiers](./deck.assets/image1.png)");
    expect(result.stats.cloudSentCount).toBe(1);
    expect(result.stats.providersUsed).toContain("apple-vision");
    expect(result.stats.providersUsed).toContain("anthropic");
    expect(result.stats.providerLabel).toContain("hybrid");
  });

  it("upgrades prior local image metadata to cloud on a later run", async () => {
    appleVisionMocks.inspectAppleVisionCapability.mockResolvedValue({
      available: false,
      compilerAvailable: false,
      helperSourceExists: true,
      status: "unavailable",
      cacheRootPath
    });
    tesseractMocks.inspectTesseractCapability.mockResolvedValue({ available: false });

    const cloudKeyResolver: CloudImageKeyResolver = {
      resolve: vi.fn().mockResolvedValue({
        provider: "openai",
        apiKey: "cloud-key",
        source: "environment"
      })
    };
    const cloudClient: CloudImageInferenceClient = {
      enrichImages: vi.fn().mockResolvedValue({
        results: new Map([
          [
            "sha256:upgrade",
            {
              contentHash: "sha256:upgrade",
              useful: true,
              altText: "Dashboard screenshot showing KPI summary cards",
              detail: "Shows a product analytics dashboard with charts and KPI cards."
            }
          ]
        ]),
        failureMessages: []
      }),
      testProvider: vi.fn()
    };

    const service = new ImageEnrichmentService(cacheRootPath, "/tmp/appleVisionOcr.swift", cloudKeyResolver, cloudClient);
    const result = await service.enrichMarkdown(
      [
        "![Comparison graphic Hairburst versus drugstore multivitamin](./deck.assets/image1.png)",
        "<!-- gdrivesync:image-meta {\"v\":1,\"hash\":\"sha256:upgrade\",\"source\":\"apple-vision\",\"ocr\":\"Comparison graphic Hairburst versus drugstore multivitamin\"} -->"
      ].join("\n"),
      [buildAsset("deck.assets/image1.png", "sha256:upgrade")],
      {
        mode: "cloud",
        provider: "auto",
        cloudProvider: "openai",
        maxImagesPerRun: 25,
        store: "alt-plus-comment",
        onlyWhenAltGeneric: true
      }
    );

    expect(result.markdown).toContain("![Dashboard screenshot showing KPI summary cards](./deck.assets/image1.png)");
    expect(result.markdown).toContain("\"source\":\"openai\"");
    expect(result.stats.upgradeCandidateCount).toBe(1);
    expect(result.stats.cloudSentCount).toBe(1);
  });

  it("upgrades alt-only local machine output to cloud by matching cached OCR", async () => {
    appleVisionMocks.inspectAppleVisionCapability.mockResolvedValue({
      available: true,
      compilerAvailable: true,
      helperSourceExists: true,
      status: "compiled",
      cacheRootPath,
      binaryPath: "/tmp/apple-vision"
    });
    appleVisionMocks.runAppleVisionOcr.mockImplementation(async (imagePaths: string[]) => {
      const map = new Map<string, { path: string; text: string }>();
      for (const imagePath of imagePaths) {
        map.set(path.resolve(imagePath), {
          path: path.resolve(imagePath),
          text: "Comparison graphic Hairburst versus drugstore multivitamin"
        });
      }
      return map;
    });
    tesseractMocks.inspectTesseractCapability.mockResolvedValue({ available: false });

    const localService = new ImageEnrichmentService(cacheRootPath, "/tmp/appleVisionOcr.swift");
    await localService.enrichMarkdown(
      "![Slide 1 image 1](./deck.assets/image1.png)",
      [buildAsset("deck.assets/image1.png", "sha256:alt-only-upgrade")],
      {
        mode: "local",
        provider: "auto",
        cloudProvider: "openai",
        maxImagesPerRun: 25,
        store: "alt-only",
        onlyWhenAltGeneric: true
      }
    );

    const cloudKeyResolver: CloudImageKeyResolver = {
      resolve: vi.fn().mockResolvedValue({
        provider: "openai",
        apiKey: "cloud-key",
        source: "environment"
      })
    };
    const cloudClient: CloudImageInferenceClient = {
      enrichImages: vi.fn().mockResolvedValue({
        results: new Map([
          [
            "sha256:alt-only-upgrade",
            {
              contentHash: "sha256:alt-only-upgrade",
              useful: true,
              altText: "Performance dashboard screenshot with KPI cards",
              detail: "Shows a dashboard with charts, KPI cards, and sidebar filters."
            }
          ]
        ]),
        failureMessages: []
      }),
      testProvider: vi.fn()
    };

    const cloudService = new ImageEnrichmentService(cacheRootPath, "/tmp/appleVisionOcr.swift", cloudKeyResolver, cloudClient);
    const upgraded = await cloudService.enrichMarkdown(
      "![Comparison graphic Hairburst versus drugstore multivitamin](./deck.assets/image1.png)",
      [buildAsset("deck.assets/image1.png", "sha256:alt-only-upgrade")],
      {
        mode: "cloud",
        provider: "auto",
        cloudProvider: "openai",
        maxImagesPerRun: 25,
        store: "alt-plus-comment",
        onlyWhenAltGeneric: true
      }
    );

    expect(upgraded.markdown).toContain("![Performance dashboard screenshot with KPI cards](./deck.assets/image1.png)");
    expect(upgraded.markdown).toContain("\"source\":\"openai\"");
    expect(upgraded.stats.upgradeCandidateCount).toBe(1);
  });

  it("does not auto-upgrade cloud image metadata when switching providers", async () => {
    appleVisionMocks.inspectAppleVisionCapability.mockResolvedValue({
      available: false,
      compilerAvailable: false,
      helperSourceExists: true,
      status: "unavailable",
      cacheRootPath
    });
    tesseractMocks.inspectTesseractCapability.mockResolvedValue({ available: false });

    const cloudKeyResolver: CloudImageKeyResolver = {
      resolve: vi.fn().mockResolvedValue({
        provider: "anthropic",
        apiKey: "anthropic-key",
        source: "environment"
      })
    };
    const cloudClient: CloudImageInferenceClient = {
      enrichImages: vi.fn().mockResolvedValue({
        results: new Map(),
        failureMessages: []
      }),
      testProvider: vi.fn()
    };

    const existingMarkdown = [
      "![Dashboard screenshot showing KPI summary cards](./deck.assets/image1.png)",
      "<!-- gdrivesync:image-meta {\"v\":1,\"hash\":\"sha256:cloud-lock\",\"source\":\"openai\",\"model\":\"gpt-5.4-nano\",\"detail\":\"Shows a product analytics dashboard with charts and KPI cards.\"} -->"
    ].join("\n");

    const service = new ImageEnrichmentService(cacheRootPath, "/tmp/appleVisionOcr.swift", cloudKeyResolver, cloudClient);
    const result = await service.enrichMarkdown(
      existingMarkdown,
      [buildAsset("deck.assets/image1.png", "sha256:cloud-lock")],
      {
        mode: "cloud",
        provider: "auto",
        cloudProvider: "anthropic",
        maxImagesPerRun: 25,
        store: "alt-plus-comment",
        onlyWhenAltGeneric: true
      }
    );

    expect(result.markdown).toBe(existingMarkdown);
    expect(result.stats.eligibleImageCount).toBe(0);
    expect(cloudClient.enrichImages).not.toHaveBeenCalled();
  });
});
