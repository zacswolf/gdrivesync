import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { inspectAppleVisionCapability, runAppleVisionOcr } from "./appleVisionOcr";
import {
  CloudCredentialSource,
  CloudImageInferenceClient,
  CloudImageKeyResolver,
  CloudImageProvider,
  HttpCloudImageInferenceClient,
  ImageEnrichmentProviderName,
  ResolvedCloudApiKey,
  formatCloudProviderLabel,
  getDefaultCloudModel,
  resolveCloudModel
} from "./cloudImageProviders";
import { inspectTesseractCapability, runTesseractOcr } from "./tesseractOcr";
import { GeneratedFilePayload } from "./types";
import { sha256Bytes } from "./utils/hash";

export type ImageEnrichmentMode = "off" | "local" | "prompt" | "cloud" | "hybrid";
export type ImageEnrichmentProvider = "auto" | "apple-vision" | "tesseract";
export type ImageEnrichmentCloudProvider = CloudImageProvider;
export type ImageEnrichmentStoreMode = "alt-only" | "alt-plus-comment";

export interface ImageEnrichmentSettings {
  mode: ImageEnrichmentMode;
  provider: ImageEnrichmentProvider;
  cloudProvider: ImageEnrichmentCloudProvider;
  cloudModel?: string;
  maxImagesPerRun: number;
  store: ImageEnrichmentStoreMode;
  onlyWhenAltGeneric: boolean;
}

export interface ImageEnrichmentStats {
  eligibleImageCount: number;
  genericCandidateCount: number;
  upgradeCandidateCount: number;
  processedImageCount: number;
  enrichedImageCount: number;
  cacheHitCount: number;
  commentCount: number;
  provider?: ImageEnrichmentProviderName;
  providerLabel?: string;
  providersUsed: ImageEnrichmentProviderName[];
  cloudProvider?: CloudImageProvider;
  cloudModel?: string;
  cloudKeySource?: CloudCredentialSource;
  cloudSentCount: number;
  skippedImageCount: number;
  failureMessages: string[];
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
  existingMeta?: ParsedImageMetaComment;
}

type ImageReferenceClassification = "generic" | "human" | "machine-local" | "machine-cloud";

interface ParsedImageMetaComment {
  source: ImageEnrichmentProviderName;
  hash?: string;
  model?: string;
}

interface ClassifiedImageReferenceCandidate extends ImageReferenceCandidate {
  classification: ImageReferenceClassification;
}

interface CachedImageEnrichmentRecord {
  version: 2;
  provider: ImageEnrichmentProviderName;
  contentHash: string;
  model?: string;
  promptVersion: number;
  normalizedText?: string;
  detail?: string;
  altText: string;
  createdAt: string;
}

interface OcrCandidate {
  stagedImagePath: string;
  candidate: ImageReferenceCandidate;
}

interface PendingCloudCandidate {
  candidate: ImageReferenceCandidate;
}

const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\s]+)\)(?:\r?\n<!-- gdrivesync:image-meta (\{[^\n]*\}) -->)?/g;
const INLINE_DATA_URI_PATTERN = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;
const MIN_IMAGE_AREA = 18_000;
const MIN_IMAGE_EDGE = 96;
const OCR_COMMENT_MAX_LENGTH = 500;
const ALT_TEXT_MAX_LENGTH = 140;
const CLOUD_PROMPT_VERSION = 1;
const LOCAL_PROMPT_VERSION = 1;
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

function buildEmptyStats(): ImageEnrichmentStats {
  return {
    eligibleImageCount: 0,
    genericCandidateCount: 0,
    upgradeCandidateCount: 0,
    processedImageCount: 0,
    enrichedImageCount: 0,
    cacheHitCount: 0,
    commentCount: 0,
    providersUsed: [],
    cloudSentCount: 0,
    skippedImageCount: 0,
    failureMessages: []
  };
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

function formatProviderLabel(provider: ImageEnrichmentProviderName, model?: string): string {
  if (provider === "openai" || provider === "anthropic") {
    const cloudLabel = formatCloudProviderLabel(provider);
    return model ? `${cloudLabel} (${model})` : cloudLabel;
  }

  return provider;
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

function parseImageMetaComment(
  rawPayload: string | undefined,
  asset: GeneratedFilePayload
): ParsedImageMetaComment | undefined {
  if (!rawPayload) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawPayload) as Record<string, unknown>;
    const source = parsed.source;
    if (
      source !== "apple-vision" &&
      source !== "tesseract" &&
      source !== "openai" &&
      source !== "anthropic"
    ) {
      return undefined;
    }

    const hash = typeof parsed.hash === "string" ? parsed.hash : undefined;
    if (hash && hash !== asset.contentHash) {
      return undefined;
    }

    return {
      source,
      hash,
      model: typeof parsed.model === "string" ? parsed.model : undefined
    };
  } catch {
    return undefined;
  }
}

function collectImageReferenceCandidates(markdown: string, assets: GeneratedFilePayload[]): ImageReferenceCandidate[] {
  const assetByPath = new Map(
    assets
      .filter((asset) => RASTER_MIME_TYPES.has(asset.mimeType))
      .map((asset) => [normalizeRelativeAssetPath(asset.relativePath), asset])
  );
  const candidates: ImageReferenceCandidate[] = [];
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_IMAGE_PATTERN.exec(markdown))) {
    const altText = match[1] || "";
    const imagePath = normalizeRelativeAssetPath(match[2] || "");
    const asset = resolveCandidateAsset(imagePath, assetByPath);
    if (!asset) {
      continue;
    }
    if (isTooSmallForUsefulText(asset)) {
      continue;
    }

    candidates.push({
      altText,
      normalizedImagePath: imagePath,
      asset,
      existingMeta: parseImageMetaComment(match[3], asset)
    });
  }

  return candidates;
}

export function findEligibleImageReferences(
  markdown: string,
  assets: GeneratedFilePayload[],
  settings: Pick<ImageEnrichmentSettings, "onlyWhenAltGeneric">
): ImageReferenceCandidate[] {
  return collectImageReferenceCandidates(markdown, assets).filter((candidate) =>
    settings.onlyWhenAltGeneric ? isGenericImageAltText(candidate.altText) : true
  );
}

export function shouldPromptForImageEnrichment(
  mode: ImageEnrichmentMode,
  reason: "manual" | "open" | "link" | undefined,
  eligibleImageCount: number
): boolean {
  return mode === "prompt" && reason !== "open" && eligibleImageCount > 0;
}

function sanitizeCacheSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function buildCommentFromRecord(record: CachedImageEnrichmentRecord): string {
  const basePayload: Record<string, unknown> = {
    v: 1,
    hash: record.contentHash,
    source: record.provider
  };

  if (record.provider === "openai" || record.provider === "anthropic") {
    if (record.model) {
      basePayload.model = record.model;
    }
    if (record.detail) {
      basePayload.detail = record.detail;
    }
    return `<!-- gdrivesync:image-meta ${JSON.stringify(basePayload)} -->`;
  }

  const clippedOcr = (record.normalizedText || "").length > OCR_COMMENT_MAX_LENGTH
    ? `${(record.normalizedText || "").slice(0, OCR_COMMENT_MAX_LENGTH - 1).trimEnd()}…`
    : (record.normalizedText || "");
  return `<!-- gdrivesync:image-meta ${JSON.stringify({ ...basePayload, ocr: clippedOcr })} -->`;
}

async function loadCachedResult(
  cacheRootPath: string,
  provider: ImageEnrichmentProviderName,
  contentHash: string,
  options?: { model?: string; promptVersion?: number }
): Promise<CachedImageEnrichmentRecord | undefined> {
  const cacheDirectory =
    provider === "openai" || provider === "anthropic"
      ? path.join(cacheRootPath, "results", provider, sanitizeCacheSegment(options?.model || getDefaultCloudModel(provider)))
      : path.join(cacheRootPath, "results", provider);
  const cachePath = path.join(cacheDirectory, `${contentHash.replace(/^sha256:/, "")}.json`);
  if (!(await pathExists(cachePath))) {
    return undefined;
  }

  try {
    const rawValue = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(rawValue) as {
      version?: number;
      provider?: ImageEnrichmentProviderName;
      contentHash?: string;
      model?: string;
      promptVersion?: number;
      normalizedText?: string;
      detail?: string;
      altText?: string;
      createdAt?: string;
    };
    if (parsed.version === 2) {
      if (
        parsed.provider === provider &&
        parsed.contentHash === contentHash &&
        typeof parsed.altText === "string" &&
        parsed.promptVersion === (options?.promptVersion || LOCAL_PROMPT_VERSION)
      ) {
        return {
          version: 2,
          provider,
          contentHash,
          model: typeof parsed.model === "string" ? parsed.model : undefined,
          promptVersion: parsed.promptVersion,
          normalizedText: typeof parsed.normalizedText === "string" ? parsed.normalizedText : undefined,
          detail: typeof parsed.detail === "string" ? parsed.detail : undefined,
          altText: parsed.altText,
          createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString()
        };
      }
    }

    if (
      parsed.version === 1 &&
      provider !== "openai" &&
      provider !== "anthropic" &&
      parsed.provider === provider &&
      parsed.contentHash === contentHash &&
      typeof parsed.normalizedText === "string" &&
      typeof parsed.altText === "string"
    ) {
      return {
        version: 2,
        provider,
        contentHash,
        promptVersion: LOCAL_PROMPT_VERSION,
        normalizedText: parsed.normalizedText,
        altText: parsed.altText,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString()
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function saveCachedResult(cacheRootPath: string, record: CachedImageEnrichmentRecord): Promise<void> {
  const resultsDirectory =
    record.provider === "openai" || record.provider === "anthropic"
      ? path.join(cacheRootPath, "results", record.provider, sanitizeCacheSegment(record.model || getDefaultCloudModel(record.provider)))
      : path.join(cacheRootPath, "results", record.provider);
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
    private readonly appleVisionHelperSourcePath: string,
    private readonly cloudKeyResolver?: CloudImageKeyResolver,
    private readonly cloudInferenceClient: CloudImageInferenceClient = new HttpCloudImageInferenceClient()
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

  private async findMatchingLocalCachedRecord(candidate: ImageReferenceCandidate): Promise<CachedImageEnrichmentRecord | undefined> {
    const normalizedAlt = candidate.altText.trim();
    if (!normalizedAlt) {
      return undefined;
    }

    for (const provider of ["apple-vision", "tesseract"] as const) {
      const cached = await loadCachedResult(this.cacheRootPath, provider, candidate.asset.contentHash, {
        promptVersion: LOCAL_PROMPT_VERSION
      });
      if (cached?.altText.trim() === normalizedAlt) {
        return cached;
      }
    }

    return undefined;
  }

  private async classifyCandidates(
    candidates: ImageReferenceCandidate[],
    settings: ImageEnrichmentSettings
  ): Promise<ClassifiedImageReferenceCandidate[]> {
    const classified: ClassifiedImageReferenceCandidate[] = [];
    for (const candidate of candidates) {
      let classification: ImageReferenceClassification;
      if (candidate.existingMeta?.source === "apple-vision" || candidate.existingMeta?.source === "tesseract") {
        classification = "machine-local";
      } else if (candidate.existingMeta?.source === "openai" || candidate.existingMeta?.source === "anthropic") {
        classification = "machine-cloud";
      } else if (isGenericImageAltText(candidate.altText)) {
        classification = "generic";
      } else if ((settings.mode === "cloud" || settings.mode === "hybrid") && (await this.findMatchingLocalCachedRecord(candidate))) {
        classification = "machine-local";
      } else {
        classification = "human";
      }

      classified.push({
        ...candidate,
        classification
      });
    }

    return classified;
  }

  private shouldUseLocalStageCandidate(
    candidate: ClassifiedImageReferenceCandidate,
    settings: ImageEnrichmentSettings
  ): boolean {
    if (candidate.classification === "machine-cloud" || candidate.classification === "machine-local") {
      return false;
    }

    if (candidate.classification === "generic") {
      return true;
    }

    return !settings.onlyWhenAltGeneric;
  }

  private shouldUseCloudStageCandidate(
    candidate: ClassifiedImageReferenceCandidate,
    settings: ImageEnrichmentSettings
  ): boolean {
    if (candidate.classification === "machine-cloud") {
      return false;
    }

    if (candidate.classification === "machine-local") {
      return settings.mode === "cloud" || settings.mode === "hybrid";
    }

    if (candidate.classification === "generic") {
      return true;
    }

    return !settings.onlyWhenAltGeneric;
  }

  async enrichMarkdown(
    markdown: string,
    assets: GeneratedFilePayload[],
    settings: ImageEnrichmentSettings,
    progress?: ImageEnrichmentProgressReporter
  ): Promise<{ markdown: string; stats: ImageEnrichmentStats }> {
    if (settings.mode === "off" || settings.mode === "prompt") {
      return {
        markdown,
        stats: buildEmptyStats()
      };
    }

    const candidates = collectImageReferenceCandidates(markdown, assets);
    if (candidates.length === 0) {
      return {
        markdown,
        stats: buildEmptyStats()
      };
    }

    const classifiedCandidates = await this.classifyCandidates(candidates, settings);
    const genericCandidates = classifiedCandidates.filter((candidate) => candidate.classification === "generic");
    const localUpgradeCandidates = classifiedCandidates.filter((candidate) => candidate.classification === "machine-local");
    const localStageCandidates = classifiedCandidates.filter((candidate) => this.shouldUseLocalStageCandidate(candidate, settings));
    const cloudDirectCandidates = classifiedCandidates.filter((candidate) => this.shouldUseCloudStageCandidate(candidate, settings));
    const eligibleImageCount =
      settings.mode === "local"
        ? localStageCandidates.length
        : settings.mode === "cloud"
          ? cloudDirectCandidates.length
          : new Set([...localStageCandidates, ...cloudDirectCandidates].map((candidate) => candidate.normalizedImagePath)).size;

    if (eligibleImageCount === 0) {
      return {
        markdown,
        stats: buildEmptyStats()
      };
    }

    progress?.report("Analyzing images…");
    const enrichedByPath = new Map<string, CachedImageEnrichmentRecord>();
    const providersUsed = new Set<ImageEnrichmentProviderName>();
    const failureMessages = new Set<string>();
    let processedImageCount = 0;
    let cacheHitCount = 0;
    let cloudSentCount = 0;
    let primaryProvider: ImageEnrichmentProviderName | undefined;
    let providerLabel: string | undefined;
    let cloudModel: string | undefined;
    let cloudKeySource: CloudCredentialSource | undefined;

    let unresolvedCandidates: ImageReferenceCandidate[] = [...localStageCandidates];

    if (settings.mode === "local" || settings.mode === "hybrid") {
      const localOutcome = await this.applyLocalEnrichment(unresolvedCandidates, settings, progress);
      unresolvedCandidates = localOutcome.unresolvedCandidates;
      processedImageCount += localOutcome.processedImageCount;
      cacheHitCount += localOutcome.cacheHitCount;
      for (const [key, value] of localOutcome.enrichedByPath.entries()) {
        enrichedByPath.set(key, value);
      }
      localOutcome.failureMessages.forEach((message) => failureMessages.add(message));
      if (localOutcome.provider) {
        providersUsed.add(localOutcome.provider);
        primaryProvider = localOutcome.provider;
        providerLabel = formatProviderLabel(localOutcome.provider);
      }
    }

    if (settings.mode === "cloud" || settings.mode === "hybrid") {
      const cloudCandidates: ImageReferenceCandidate[] =
        settings.mode === "hybrid"
          ? [
              ...unresolvedCandidates,
              ...localUpgradeCandidates.filter(
                (candidate) => !unresolvedCandidates.some((pendingCandidate) => pendingCandidate.normalizedImagePath === candidate.normalizedImagePath)
              )
            ]
          : cloudDirectCandidates;
      const cloudOutcome = await this.applyCloudEnrichment(cloudCandidates, settings, progress);
      unresolvedCandidates = cloudOutcome.unresolvedCandidates;
      processedImageCount += cloudOutcome.processedImageCount;
      cacheHitCount += cloudOutcome.cacheHitCount;
      cloudSentCount += cloudOutcome.cloudSentCount;
      cloudKeySource = cloudOutcome.keySource;
      cloudModel = cloudOutcome.model;
      for (const [key, value] of cloudOutcome.enrichedByPath.entries()) {
        enrichedByPath.set(key, value);
      }
      cloudOutcome.failureMessages.forEach((message) => failureMessages.add(message));
      if (cloudOutcome.provider) {
        providersUsed.add(cloudOutcome.provider);
        primaryProvider = cloudOutcome.provider;
        providerLabel =
          settings.mode === "hybrid" && providersUsed.size > 1
            ? `hybrid (${[...providersUsed].map((provider) => formatProviderLabel(provider, provider === cloudOutcome.provider ? cloudModel : undefined)).join(" + ")})`
            : formatProviderLabel(cloudOutcome.provider, cloudModel);
      }
    }

    if (settings.mode === "cloud" && !primaryProvider) {
      providerLabel = formatProviderLabel(settings.cloudProvider, cloudModel);
    }

    let enrichedImageCount = 0;
    let commentCount = 0;
    const rewrittenMarkdown = markdown.replace(
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
        return `${rewrittenImage}\n${buildCommentFromRecord(enriched)}`;
      }
    );

    return {
      markdown: rewrittenMarkdown,
      stats: {
        eligibleImageCount,
        genericCandidateCount: genericCandidates.length,
        upgradeCandidateCount: settings.mode === "cloud" || settings.mode === "hybrid" ? localUpgradeCandidates.length : 0,
        processedImageCount,
        enrichedImageCount,
        cacheHitCount,
        commentCount,
        provider: primaryProvider,
        providerLabel,
        providersUsed: [...providersUsed],
        cloudProvider: settings.mode === "cloud" || settings.mode === "hybrid" ? settings.cloudProvider : undefined,
        cloudModel,
        cloudKeySource,
        cloudSentCount,
        skippedImageCount: Math.max(0, eligibleImageCount - enrichedImageCount),
        failureMessages: [...failureMessages]
      }
    };
  }

  private async applyLocalEnrichment(
    candidates: ImageReferenceCandidate[],
    settings: ImageEnrichmentSettings,
    progress?: ImageEnrichmentProgressReporter
  ): Promise<{
    provider?: "apple-vision" | "tesseract";
    enrichedByPath: Map<string, CachedImageEnrichmentRecord>;
    unresolvedCandidates: ImageReferenceCandidate[];
    processedImageCount: number;
    cacheHitCount: number;
    failureMessages: string[];
  }> {
    if (candidates.length === 0) {
      return {
        enrichedByPath: new Map(),
        unresolvedCandidates: [],
        processedImageCount: 0,
        cacheHitCount: 0,
        failureMessages: []
      };
    }

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
        enrichedByPath: new Map(),
        unresolvedCandidates: candidates,
        processedImageCount: 0,
        cacheHitCount: 0,
        failureMessages: []
      };
    }

    const enrichedByPath = new Map<string, CachedImageEnrichmentRecord>();
    let cacheHitCount = 0;
    const pendingCandidates: OcrCandidate[] = [];
    for (const candidate of candidates) {
      const cached = await loadCachedResult(this.cacheRootPath, provider, candidate.asset.contentHash, {
        promptVersion: LOCAL_PROMPT_VERSION
      });
      if (cached) {
        enrichedByPath.set(candidate.normalizedImagePath, cached);
        cacheHitCount += 1;
        continue;
      }

      pendingCandidates.push({
        stagedImagePath: await stageAssetForOcr(this.cacheRootPath, candidate.asset),
        candidate
      });
    }

    const unresolvedCandidates: ImageReferenceCandidate[] = [];
    if (pendingCandidates.length > 0) {
      try {
        const imagePaths = pendingCandidates.map((entry) => entry.stagedImagePath);
        const providerResults =
          provider === "apple-vision"
            ? await runAppleVisionOcr(imagePaths, this.cacheRootPath, this.appleVisionHelperSourcePath)
            : await runTesseractOcr(imagePaths, capabilityReport.tesseract.path);

        let completedCount = 0;
        for (const pendingCandidate of pendingCandidates) {
          completedCount += 1;
          progress?.report(`Enriching images ${completedCount}/${pendingCandidates.length}…`);
          const providerResult = providerResults.get(path.resolve(pendingCandidate.stagedImagePath));
          const normalizedText = normalizeOcrText(providerResult?.text);
          const altText = deriveAltText(normalizedText);
          if (!altText) {
            unresolvedCandidates.push(pendingCandidate.candidate);
            continue;
          }

          const record: CachedImageEnrichmentRecord = {
            version: 2,
            provider,
            contentHash: pendingCandidate.candidate.asset.contentHash,
            promptVersion: LOCAL_PROMPT_VERSION,
            normalizedText,
            altText,
            createdAt: new Date().toISOString()
          };
          enrichedByPath.set(pendingCandidate.candidate.normalizedImagePath, record);
          await saveCachedResult(this.cacheRootPath, record);
        }
      } catch (error) {
        return {
          provider,
          enrichedByPath,
          unresolvedCandidates: pendingCandidates.map((entry) => entry.candidate),
          processedImageCount: pendingCandidates.length,
          cacheHitCount,
          failureMessages: [error instanceof Error ? error.message : String(error)]
        };
      }
    }

    return {
      provider,
      enrichedByPath,
      unresolvedCandidates,
      processedImageCount: pendingCandidates.length,
      cacheHitCount,
      failureMessages: []
    };
  }

  private async applyCloudEnrichment(
    candidates: ImageReferenceCandidate[],
    settings: ImageEnrichmentSettings,
    progress?: ImageEnrichmentProgressReporter
  ): Promise<{
    provider?: CloudImageProvider;
    model?: string;
    keySource?: CloudCredentialSource;
    enrichedByPath: Map<string, CachedImageEnrichmentRecord>;
    unresolvedCandidates: ImageReferenceCandidate[];
    processedImageCount: number;
    cacheHitCount: number;
    cloudSentCount: number;
    skippedImageCount: number;
    failureMessages: string[];
  }> {
    if (candidates.length === 0) {
      return {
        provider: settings.cloudProvider,
        model: resolveCloudModel(settings.cloudProvider, settings.cloudModel),
        enrichedByPath: new Map(),
        unresolvedCandidates: [],
        processedImageCount: 0,
        cacheHitCount: 0,
        cloudSentCount: 0,
        skippedImageCount: 0,
        failureMessages: []
      };
    }

    const model = resolveCloudModel(settings.cloudProvider, settings.cloudModel);
    const limitedCandidates = candidates.slice(0, Math.max(0, settings.maxImagesPerRun));
    const skippedImageCount = Math.max(0, candidates.length - limitedCandidates.length);
    const enrichedByPath = new Map<string, CachedImageEnrichmentRecord>();
    let cacheHitCount = 0;
    const pendingCandidates: PendingCloudCandidate[] = [];
    for (const candidate of limitedCandidates) {
      const cached = await loadCachedResult(this.cacheRootPath, settings.cloudProvider, candidate.asset.contentHash, {
        model,
        promptVersion: CLOUD_PROMPT_VERSION
      });
      if (cached) {
        enrichedByPath.set(candidate.normalizedImagePath, cached);
        cacheHitCount += 1;
        continue;
      }

      pendingCandidates.push({ candidate });
    }

    const resolvedKey = this.cloudKeyResolver
      ? await this.cloudKeyResolver.resolve(settings.cloudProvider)
      : ({ provider: settings.cloudProvider, source: "missing" } as ResolvedCloudApiKey);
    if (!resolvedKey.apiKey) {
      return {
        provider: settings.cloudProvider,
        model,
        keySource: resolvedKey.source,
        enrichedByPath,
        unresolvedCandidates: candidates.filter((candidate) => !enrichedByPath.has(candidate.normalizedImagePath)),
        processedImageCount: 0,
        cacheHitCount,
        cloudSentCount: 0,
        skippedImageCount,
        failureMessages: pendingCandidates.length > 0
          ? [`${formatCloudProviderLabel(settings.cloudProvider)} image enrichment is configured but no API key is available.`]
          : []
      };
    }

    const unresolvedCandidates: ImageReferenceCandidate[] = [...candidates.slice(settings.maxImagesPerRun)];
    const failureMessages: string[] = [];
    if (pendingCandidates.length > 0) {
      try {
        progress?.report(`Analyzing images with ${formatCloudProviderLabel(settings.cloudProvider)}…`);
        const batchResult = await this.cloudInferenceClient.enrichImages(
          settings.cloudProvider,
          resolvedKey.apiKey,
          model,
          pendingCandidates.map((entry) => ({
            asset: entry.candidate.asset,
            currentAltText: entry.candidate.altText
          }))
        );
        failureMessages.push(...batchResult.failureMessages);

        let completedCount = 0;
        for (const pendingCandidate of pendingCandidates) {
          completedCount += 1;
          progress?.report(`Enriching images ${completedCount}/${pendingCandidates.length}…`);
          const providerResult = batchResult.results.get(pendingCandidate.candidate.asset.contentHash);
          if (!providerResult?.useful || !providerResult.altText) {
            unresolvedCandidates.push(pendingCandidate.candidate);
            continue;
          }

          const record: CachedImageEnrichmentRecord = {
            version: 2,
            provider: settings.cloudProvider,
            contentHash: pendingCandidate.candidate.asset.contentHash,
            model,
            promptVersion: CLOUD_PROMPT_VERSION,
            detail: providerResult.detail,
            altText: providerResult.altText,
            createdAt: new Date().toISOString()
          };
          enrichedByPath.set(pendingCandidate.candidate.normalizedImagePath, record);
          await saveCachedResult(this.cacheRootPath, record);
        }
      } catch (error) {
        failureMessages.push(error instanceof Error ? error.message : String(error));
        unresolvedCandidates.push(...pendingCandidates.map((entry) => entry.candidate));
      }
    }

    return {
      provider: settings.cloudProvider,
      model,
      keySource: resolvedKey.source,
      enrichedByPath,
      unresolvedCandidates,
      processedImageCount: pendingCandidates.length,
      cacheHitCount,
      cloudSentCount: pendingCandidates.length,
      skippedImageCount,
      failureMessages
    };
  }

  async resolveCloudApiKey(provider: CloudImageProvider): Promise<ResolvedCloudApiKey> {
    if (!this.cloudKeyResolver) {
      return {
        provider,
        source: "missing"
      };
    }

    return this.cloudKeyResolver.resolve(provider);
  }

  async testCloudProvider(provider: CloudImageProvider, modelOverride?: string): Promise<{
    provider: CloudImageProvider;
    model: string;
    keySource: CloudCredentialSource;
  }> {
    const resolvedKey = await this.resolveCloudApiKey(provider);
    if (!resolvedKey.apiKey) {
      throw new Error(`${formatCloudProviderLabel(provider)} is not configured yet.`);
    }

    const model = resolveCloudModel(provider, modelOverride);
    await this.cloudInferenceClient.testProvider(provider, resolvedKey.apiKey, model);
    return {
      provider,
      model,
      keySource: resolvedKey.source
    };
  }
}
