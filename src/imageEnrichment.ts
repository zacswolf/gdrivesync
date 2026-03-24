import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { inspectAppleVisionCapability, runAppleVisionOcr } from "./appleVisionOcr";
import { inspectTesseractCapability, runTesseractOcr } from "./tesseractOcr";
import { GeneratedFilePayload } from "./types";
import { sha256Bytes } from "./utils/hash";

export type ImageEnrichmentMode = "off" | "local" | "prompt";
export type ImageEnrichmentProvider = "auto" | "apple-vision" | "tesseract";
export type ImageEnrichmentStoreMode = "alt-only" | "alt-plus-comment";

export interface ImageEnrichmentSettings {
  mode: ImageEnrichmentMode;
  provider: ImageEnrichmentProvider;
  store: ImageEnrichmentStoreMode;
  onlyWhenAltGeneric: boolean;
}

export interface ImageEnrichmentStats {
  eligibleImageCount: number;
  processedImageCount: number;
  enrichedImageCount: number;
  cacheHitCount: number;
  commentCount: number;
  provider?: "apple-vision" | "tesseract";
}

export interface ImageEnrichmentCapabilityReport {
  cacheRootPath: string;
  appleVision: Awaited<ReturnType<typeof inspectAppleVisionCapability>>;
  tesseract: Awaited<ReturnType<typeof inspectTesseractCapability>>;
}

export interface ImageEnrichmentProgressReporter {
  report(message: string): void;
}

interface ImageReferenceCandidate {
  altText: string;
  normalizedImagePath: string;
  asset: GeneratedFilePayload;
}

interface CachedImageEnrichmentRecord {
  version: 1;
  provider: "apple-vision" | "tesseract";
  contentHash: string;
  normalizedText: string;
  altText: string;
  createdAt: string;
}

interface OcrCandidate {
  stagedImagePath: string;
  candidate: ImageReferenceCandidate;
}

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const IMAGE_META_COMMENT_PATTERN = /\n?<!-- gdrivesync:image-meta \{[^\n]*\} -->/g;
const INLINE_DATA_URI_PATTERN = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;
const MIN_IMAGE_AREA = 18_000;
const MIN_IMAGE_EDGE = 96;
const OCR_COMMENT_MAX_LENGTH = 500;
const ALT_TEXT_MAX_LENGTH = 140;
const RASTER_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff"
]);

function normalizeRelativeAssetPath(assetPath: string): string {
  return assetPath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function escapeMarkdownAltText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

export function normalizeOcrText(rawValue: string | undefined): string {
  if (!rawValue) {
    return "";
  }

  return rawValue
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMeaningfulOcrText(value: string): boolean {
  if (!value) {
    return false;
  }

  const tokens = value.split(/\s+/).filter(Boolean);
  const letterCount = (value.match(/[A-Za-z]/g) || []).length;
  if (tokens.length < 2 && value.length < 10) {
    return false;
  }

  return letterCount >= 6;
}

export function isGenericImageAltText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  if (
    normalized === "image" ||
    normalized === "background" ||
    /^(image|picture|photo|graphic|screenshot|background|icon)[-\s_]*\d*$/.test(normalized) ||
    /^slide[-\s_]*\d+[-\s_]+(image|picture|photo|graphic|screenshot|icon)[-\s_]*\d+$/.test(normalized) ||
    /^slide[-\s_]*\d+[-\s_]+background$/.test(normalized)
  ) {
    return true;
  }

  return false;
}

export function deriveAltText(normalizedOcrText: string): string | undefined {
  if (!isMeaningfulOcrText(normalizedOcrText)) {
    return undefined;
  }

  const clipped = normalizedOcrText.length > ALT_TEXT_MAX_LENGTH
    ? `${normalizedOcrText.slice(0, ALT_TEXT_MAX_LENGTH - 1).trimEnd()}…`
    : normalizedOcrText;
  return clipped;
}

function buildImageMetaComment(contentHash: string, provider: "apple-vision" | "tesseract", normalizedOcrText: string): string {
  const clippedOcr = normalizedOcrText.length > OCR_COMMENT_MAX_LENGTH
    ? `${normalizedOcrText.slice(0, OCR_COMMENT_MAX_LENGTH - 1).trimEnd()}…`
    : normalizedOcrText;
  return `<!-- gdrivesync:image-meta ${JSON.stringify({ v: 1, hash: contentHash, source: provider, ocr: clippedOcr })} -->`;
}

function mimeTypeToExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") {
    return ".jpg";
  }
  if (mimeType === "image/png") {
    return ".png";
  }
  if (mimeType === "image/gif") {
    return ".gif";
  }
  if (mimeType === "image/webp") {
    return ".webp";
  }
  if (mimeType === "image/bmp") {
    return ".bmp";
  }
  if (mimeType === "image/tiff") {
    return ".tiff";
  }

  return ".img";
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) {
    return undefined;
  }

  const signature = Buffer.from(bytes.slice(0, 8)).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    return undefined;
  }

  return {
    width: bytes[16] * 2 ** 24 + bytes[17] * 2 ** 16 + bytes[18] * 2 ** 8 + bytes[19],
    height: bytes[20] * 2 ** 24 + bytes[21] * 2 ** 16 + bytes[22] * 2 ** 8 + bytes[23]
  };
}

function parseGifDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 10) {
    return undefined;
  }
  const header = Buffer.from(bytes.slice(0, 6)).toString("ascii");
  if (header !== "GIF87a" && header !== "GIF89a") {
    return undefined;
  }

  return {
    width: bytes[6] + bytes[7] * 256,
    height: bytes[8] + bytes[9] * 256
  };
}

function parseJpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    const blockLength = bytes[offset + 2] * 256 + bytes[offset + 3];
    if (blockLength < 2) {
      return undefined;
    }

    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: bytes[offset + 5] * 256 + bytes[offset + 6],
        width: bytes[offset + 7] * 256 + bytes[offset + 8]
      };
    }

    offset += 2 + blockLength;
  }

  return undefined;
}

function getImageDimensions(asset: GeneratedFilePayload): { width: number; height: number } | undefined {
  if (asset.mimeType === "image/png") {
    return parsePngDimensions(asset.bytes);
  }
  if (asset.mimeType === "image/jpeg") {
    return parseJpegDimensions(asset.bytes);
  }
  if (asset.mimeType === "image/gif") {
    return parseGifDimensions(asset.bytes);
  }

  return undefined;
}

function isTooSmallForUsefulText(asset: GeneratedFilePayload): boolean {
  const dimensions = getImageDimensions(asset);
  if (!dimensions) {
    return false;
  }

  return (
    dimensions.width < MIN_IMAGE_EDGE ||
    dimensions.height < MIN_IMAGE_EDGE ||
    dimensions.width * dimensions.height < MIN_IMAGE_AREA
  );
}

function stripExistingImageMetaComments(markdown: string): string {
  return markdown.replace(IMAGE_META_COMMENT_PATTERN, "");
}

function resolveCandidateAsset(
  imagePath: string,
  assetByPath: Map<string, GeneratedFilePayload>
): GeneratedFilePayload | undefined {
  const normalizedImagePath = normalizeRelativeAssetPath(imagePath);
  const asset = assetByPath.get(normalizedImagePath);
  if (asset) {
    return asset;
  }

  const dataUriMatch = imagePath.match(INLINE_DATA_URI_PATTERN);
  if (!dataUriMatch) {
    return undefined;
  }

  const mimeType = dataUriMatch[1];
  const base64Value = dataUriMatch[2];
  if (!RASTER_MIME_TYPES.has(mimeType)) {
    return undefined;
  }

  const bytes = Uint8Array.from(Buffer.from(base64Value, "base64"));
  return {
    relativePath: `inline:${sha256Bytes(bytes).replace(/^sha256:/, "")}${mimeTypeToExtension(mimeType)}`,
    bytes,
    mimeType,
    contentHash: sha256Bytes(bytes)
  };
}

export function findEligibleImageReferences(
  markdown: string,
  assets: GeneratedFilePayload[],
  settings: Pick<ImageEnrichmentSettings, "onlyWhenAltGeneric">
): ImageReferenceCandidate[] {
  const assetByPath = new Map(
    assets
      .filter((asset) => RASTER_MIME_TYPES.has(asset.mimeType))
      .map((asset) => [normalizeRelativeAssetPath(asset.relativePath), asset])
  );
  const cleanedMarkdown = stripExistingImageMetaComments(markdown);
  const candidates: ImageReferenceCandidate[] = [];
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_IMAGE_PATTERN.exec(cleanedMarkdown))) {
    const altText = match[1] || "";
    const imagePath = normalizeRelativeAssetPath(match[2] || "");
    const asset = resolveCandidateAsset(imagePath, assetByPath);
    if (!asset) {
      continue;
    }
    if (settings.onlyWhenAltGeneric && !isGenericImageAltText(altText)) {
      continue;
    }
    if (isTooSmallForUsefulText(asset)) {
      continue;
    }

    candidates.push({
      altText,
      normalizedImagePath: imagePath,
      asset
    });
  }

  return candidates;
}

export function shouldPromptForImageEnrichment(
  mode: ImageEnrichmentMode,
  reason: "manual" | "open" | "link" | undefined,
  eligibleImageCount: number
): boolean {
  return mode === "prompt" && reason !== "open" && eligibleImageCount > 0;
}

async function loadCachedResult(
  cacheRootPath: string,
  provider: "apple-vision" | "tesseract",
  contentHash: string
): Promise<CachedImageEnrichmentRecord | undefined> {
  const cachePath = path.join(cacheRootPath, "results", provider, `${contentHash.replace(/^sha256:/, "")}.json`);
  if (!(await pathExists(cachePath))) {
    return undefined;
  }

  try {
    const rawValue = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(rawValue) as CachedImageEnrichmentRecord;
    if (
      parsed.version === 1 &&
      parsed.provider === provider &&
      parsed.contentHash === contentHash &&
      typeof parsed.normalizedText === "string" &&
      typeof parsed.altText === "string"
    ) {
      return parsed;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function saveCachedResult(cacheRootPath: string, record: CachedImageEnrichmentRecord): Promise<void> {
  const resultsDirectory = path.join(cacheRootPath, "results", record.provider);
  await mkdir(resultsDirectory, { recursive: true });
  const cachePath = path.join(resultsDirectory, `${record.contentHash.replace(/^sha256:/, "")}.json`);
  await writeFile(cachePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function stageAssetForOcr(cacheRootPath: string, asset: GeneratedFilePayload): Promise<string> {
  const stagedDirectory = path.join(cacheRootPath, "inputs");
  await mkdir(stagedDirectory, { recursive: true });
  const stagedPath = path.join(
    stagedDirectory,
    `${asset.contentHash.replace(/^sha256:/, "")}${mimeTypeToExtension(asset.mimeType)}`
  );
  if (!(await pathExists(stagedPath))) {
    await writeFile(stagedPath, Buffer.from(asset.bytes));
  }

  return stagedPath;
}

export class ImageEnrichmentService {
  constructor(
    private readonly cacheRootPath: string,
    private readonly appleVisionHelperSourcePath: string
  ) {}

  async inspectCapabilities(): Promise<ImageEnrichmentCapabilityReport> {
    const [appleVision, tesseract] = await Promise.all([
      inspectAppleVisionCapability(this.cacheRootPath, this.appleVisionHelperSourcePath),
      inspectTesseractCapability()
    ]);
    return {
      cacheRootPath: this.cacheRootPath,
      appleVision,
      tesseract
    };
  }

  findEligibleImages(markdown: string, assets: GeneratedFilePayload[], settings: Pick<ImageEnrichmentSettings, "onlyWhenAltGeneric">) {
    return findEligibleImageReferences(markdown, assets, settings);
  }

  async enrichMarkdown(
    markdown: string,
    assets: GeneratedFilePayload[],
    settings: ImageEnrichmentSettings,
    progress?: ImageEnrichmentProgressReporter
  ): Promise<{ markdown: string; stats: ImageEnrichmentStats }> {
    const cleanedMarkdown = stripExistingImageMetaComments(markdown);
    if (settings.mode !== "local") {
      return {
        markdown: cleanedMarkdown,
        stats: {
          eligibleImageCount: 0,
          processedImageCount: 0,
          enrichedImageCount: 0,
          cacheHitCount: 0,
          commentCount: 0
        }
      };
    }

    const candidates = this.findEligibleImages(cleanedMarkdown, assets, settings);
    if (candidates.length === 0) {
      return {
        markdown: cleanedMarkdown,
        stats: {
          eligibleImageCount: 0,
          processedImageCount: 0,
          enrichedImageCount: 0,
          cacheHitCount: 0,
          commentCount: 0
        }
      };
    }

    progress?.report("Analyzing images…");

    const capabilityReport = await this.inspectCapabilities();
    const preferredProviders =
      settings.provider === "apple-vision"
        ? ["apple-vision"]
        : settings.provider === "tesseract"
          ? ["tesseract"]
          : ["apple-vision", "tesseract"];

    const provider =
      preferredProviders.find((candidate) => {
        if (candidate === "apple-vision") {
          return capabilityReport.appleVision.available;
        }

        return capabilityReport.tesseract.available;
      }) as "apple-vision" | "tesseract" | undefined;

    if (!provider) {
      return {
        markdown: cleanedMarkdown,
        stats: {
          eligibleImageCount: candidates.length,
          processedImageCount: 0,
          enrichedImageCount: 0,
          cacheHitCount: 0,
          commentCount: 0
        }
      };
    }

    const cacheHits = new Map<string, CachedImageEnrichmentRecord>();
    const pendingCandidates: OcrCandidate[] = [];
    for (const candidate of candidates) {
      const cached = await loadCachedResult(this.cacheRootPath, provider, candidate.asset.contentHash);
      if (cached) {
        cacheHits.set(candidate.normalizedImagePath, cached);
        continue;
      }

      pendingCandidates.push({
        stagedImagePath: await stageAssetForOcr(this.cacheRootPath, candidate.asset),
        candidate
      });
    }

    const pendingResults = new Map<string, CachedImageEnrichmentRecord>();
    if (pendingCandidates.length > 0) {
      const imagePaths = pendingCandidates.map((entry) => entry.stagedImagePath);
      let providerResults = new Map<string, { text?: string; error?: string }>();
      if (provider === "apple-vision") {
        providerResults = await runAppleVisionOcr(imagePaths, this.cacheRootPath, this.appleVisionHelperSourcePath);
      } else {
        providerResults = await runTesseractOcr(imagePaths, capabilityReport.tesseract.path);
      }

      let completedCount = 0;
      for (const pendingCandidate of pendingCandidates) {
        completedCount += 1;
        progress?.report(`Enriching images ${completedCount}/${pendingCandidates.length}…`);
        const providerResult = providerResults.get(path.resolve(pendingCandidate.stagedImagePath));
        const normalizedText = normalizeOcrText(providerResult?.text);
        const altText = deriveAltText(normalizedText);
        if (!altText) {
          continue;
        }

        const record: CachedImageEnrichmentRecord = {
          version: 1,
          provider,
          contentHash: pendingCandidate.candidate.asset.contentHash,
          normalizedText,
          altText,
          createdAt: new Date().toISOString()
        };
        pendingResults.set(pendingCandidate.candidate.normalizedImagePath, record);
        await saveCachedResult(this.cacheRootPath, record);
      }
    }

    const enrichedByPath = new Map<string, CachedImageEnrichmentRecord>([
      ...cacheHits.entries(),
      ...pendingResults.entries()
    ]);

    let enrichedImageCount = 0;
    let commentCount = 0;
    const rewrittenMarkdown = cleanedMarkdown.replace(
      MARKDOWN_IMAGE_PATTERN,
      (fullMatch: string, altText: string, imagePath: string) => {
        const normalizedImagePath = normalizeRelativeAssetPath(imagePath);
        const enriched = enrichedByPath.get(normalizedImagePath);
        if (!enriched) {
          return fullMatch;
        }

        enrichedImageCount += 1;
        const rewrittenImage = `![${escapeMarkdownAltText(enriched.altText)}](${imagePath})`;
        if (settings.store === "alt-only") {
          return rewrittenImage;
        }

        commentCount += 1;
        return `${rewrittenImage}\n${buildImageMetaComment(enriched.contentHash, enriched.provider, enriched.normalizedText)}`;
      }
    );

    return {
      markdown: rewrittenMarkdown,
      stats: {
        eligibleImageCount: candidates.length,
        processedImageCount: pendingCandidates.length,
        enrichedImageCount,
        cacheHitCount: cacheHits.size,
        commentCount,
        provider
      }
    };
  }
}
