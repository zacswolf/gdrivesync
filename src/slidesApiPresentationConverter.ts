import path from "node:path";

import { GeneratedFilePayload } from "./types";
import { SlidesApiPageElement, SlidesApiPresentation, SlidesApiSlide, SlidesApiTextElement } from "./slidesClient";
import { sha256Bytes } from "./utils/hash";
import { slugifyForFileName } from "./utils/paths";

type FetchLike = typeof fetch;
type AssetMode = "external" | "data-uri";

interface PresentationConversionOptions {
  assetMode?: AssetMode;
  title?: string;
  includeBackgrounds?: boolean;
  onProgress?: (completedSlides: number, totalSlides: number) => void;
}

interface PresentationMarkdownResult {
  markdown: string;
  assets: GeneratedFilePayload[];
  generatedAssetPaths: string[];
  slideCount: number;
}

interface SlideParagraph {
  text: string;
  level?: number;
  isBullet?: boolean;
}

interface SlideTextBlock {
  placeholderType?: string;
  paragraphs: SlideParagraph[];
}

interface SlideImageSource {
  altText: string;
  contentUrl: string;
  sourceUrl?: string;
}

interface DownloadedSlideImage {
  bytes: Uint8Array;
  mimeType: string;
  contentHash: string;
}

interface ParsedSlide {
  title?: string;
  bodyBlocks: string[][];
  images: SlideImageSource[];
}

const TITLE_PLACEHOLDER_TYPES = new Set(["TITLE", "CENTERED_TITLE"]);
const BODY_PLACEHOLDER_TYPES = new Set(["BODY", "SUBTITLE", "OBJECT"]);
const SLIDE_RENDER_CONCURRENCY = 2;
const SLIDE_IMAGE_DOWNLOAD_CONCURRENCY = 4;

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function toMarkdownAssetPath(relativePath: string): string {
  return relativePath.startsWith("./") ? relativePath : `./${relativePath}`;
}

function buildDataUri(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function buildAssetFileNameBase(slideIndex: number, imageIndex: number, altText: string): string {
  const suffix = slugifyForFileName(altText || `image-${imageIndex}`);
  return `slide-${slideIndex}-${suffix}`;
}

function buildAssetDownloadCacheKey(image: SlideImageSource): string {
  return image.sourceUrl || image.contentUrl;
}

function buildDeduplicatedAssetFileName(fileNameBase: string, extension: string, contentHash: string): string {
  const shortHash = contentHash.replace(/^sha256:/, "").slice(0, 12);
  return `${fileNameBase}-${shortHash}${extension}`;
}

function buildFrontmatter(deckTitle: string): string {
  return ["---", "marp: true", "theme: default", "paginate: true", `title: ${JSON.stringify(deckTitle)}`, "---"].join("\n");
}

function contentTypeToExtension(contentType: string): string {
  if (contentType.includes("jpeg")) {
    return ".jpg";
  }
  if (contentType.includes("svg")) {
    return ".svg";
  }
  if (contentType.includes("gif")) {
    return ".gif";
  }
  if (contentType.includes("webp")) {
    return ".webp";
  }
  return ".png";
}

function appendParagraphText(paragraphs: SlideParagraph[], current: SlideParagraph | undefined): void {
  if (!current) {
    return;
  }

  const normalizedText = current.text.replace(/\s+/g, " ").trim();
  if (!normalizedText) {
    return;
  }

  paragraphs.push({
    ...current,
    text: normalizedText
  });
}

function parseTextElements(textElements: SlidesApiTextElement[] | undefined): SlideParagraph[] {
  const paragraphs: SlideParagraph[] = [];
  let currentParagraph: SlideParagraph | undefined;

  for (const textElement of textElements || []) {
    if (textElement.paragraphMarker) {
      appendParagraphText(paragraphs, currentParagraph);
      currentParagraph = {
        text: "",
        level: textElement.paragraphMarker.bullet?.nestingLevel,
        isBullet: Boolean(textElement.paragraphMarker.bullet)
      };
    }

    const nextContent = textElement.textRun?.content || textElement.autoText?.content || "";
    if (!nextContent) {
      continue;
    }

    if (!currentParagraph) {
      currentParagraph = {
        text: ""
      };
    }

    currentParagraph.text += nextContent.replace(/\r/g, "");
  }

  appendParagraphText(paragraphs, currentParagraph);
  return paragraphs;
}

function extractShapeTextBlock(element: SlidesApiPageElement): SlideTextBlock | undefined {
  const textElements = element.shape?.text?.textElements;
  const paragraphs = parseTextElements(textElements);
  if (paragraphs.length === 0) {
    return undefined;
  }

  return {
    placeholderType: element.shape?.placeholder?.type,
    paragraphs
  };
}

function formatTextBlock(block: SlideTextBlock): string[] {
  const paragraphs = block.paragraphs.filter((paragraph) => paragraph.text.trim() !== "");
  if (paragraphs.length === 0) {
    return [];
  }

  const shouldRenderAsList =
    block.placeholderType !== undefined &&
    BODY_PLACEHOLDER_TYPES.has(block.placeholderType) &&
    paragraphs.some((paragraph) => paragraph.isBullet || paragraph.level !== undefined);

  if (!shouldRenderAsList) {
    return paragraphs.map((paragraph) => paragraph.text);
  }

  return paragraphs.map((paragraph) => `${"  ".repeat(paragraph.level ?? 0)}- ${paragraph.text}`);
}

function parseSlide(
  slide: SlidesApiSlide,
  slideIndex: number,
  options: Pick<PresentationConversionOptions, "includeBackgrounds">
): ParsedSlide {
  const textBlocks = (slide.pageElements || [])
    .map((element) => extractShapeTextBlock(element))
    .filter((block): block is SlideTextBlock => Boolean(block));

  const titleBlockIndex = textBlocks.findIndex(
    (block) => block.placeholderType && TITLE_PLACEHOLDER_TYPES.has(block.placeholderType)
  );
  const title =
    titleBlockIndex >= 0 ? textBlocks[titleBlockIndex]?.paragraphs.map((paragraph) => paragraph.text).join(" ") : undefined;

  const bodyBlocks = textBlocks
    .filter((_, index) => index !== titleBlockIndex)
    .map((block) => formatTextBlock(block))
    .filter((block) => block.length > 0);

  const images: SlideImageSource[] = [];
  const backgroundContentUrl =
    options.includeBackgrounds === false ? undefined : slide.pageProperties?.pageBackgroundFill?.stretchedPictureFill?.contentUrl;
  if (backgroundContentUrl) {
    images.push({
      altText: `Slide ${slideIndex} background`,
      contentUrl: backgroundContentUrl
    });
  }

  for (const [imageIndex, element] of (slide.pageElements || []).entries()) {
    if (!element.image?.contentUrl) {
      continue;
    }

    images.push({
      altText:
        element.description?.trim() ||
        element.title?.trim() ||
        `Slide ${slideIndex} image ${imageIndex + 1}`,
      contentUrl: element.image.contentUrl,
      sourceUrl: element.image.sourceUrl
    });
  }

  return {
    title,
    bodyBlocks,
    images
  };
}

async function downloadAsset(
  fetchImpl: FetchLike,
  image: SlideImageSource
): Promise<DownloadedSlideImage> {
  const candidateUrls = [image.contentUrl, image.sourceUrl].filter((value): value is string => Boolean(value));

  let lastError: Error | undefined;
  for (const candidateUrl of candidateUrls) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetchImpl(candidateUrl);
        if (!response.ok) {
          throw new Error(`Google Slides asset download failed with status ${response.status}.`);
        }

        const contentType = response.headers.get("content-type") || "image/png";
        const bytes = new Uint8Array(await response.arrayBuffer());
        return {
          bytes,
          mimeType: contentType.split(";")[0]?.trim() || "image/png",
          contentHash: sha256Bytes(bytes)
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  throw new Error(`Failed to download slide image "${image.altText}": ${lastError?.message || "unknown error"}`);
}

function downloadAssetWithCache(
  fetchImpl: FetchLike,
  image: SlideImageSource,
  downloadCache: Map<string, Promise<DownloadedSlideImage>>
): Promise<DownloadedSlideImage> {
  const cacheKey = buildAssetDownloadCacheKey(image);
  const cached = downloadCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const inFlightDownload = downloadAsset(fetchImpl, image);
  downloadCache.set(cacheKey, inFlightDownload);
  return inFlightDownload;
}

async function mapWithConcurrencyLimit<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= values.length) {
        return;
      }

      results[currentIndex] = await mapper(values[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function renderSlideMarkdown(
  slide: ParsedSlide,
  slideIndex: number,
  markdownFilePath: string,
  assets: GeneratedFilePayload[],
  assetMode: AssetMode,
  fetchImpl: FetchLike,
  downloadCache: Map<string, Promise<DownloadedSlideImage>>,
  assetPathByContentHash: Map<string, string>
): Promise<string> {
  const lines: string[] = [];
  if (slide.title) {
    lines.push(`# ${slide.title}`);
  }

  for (const block of slide.bodyBlocks) {
    if (block.length === 0) {
      continue;
    }
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(...block);
  }

  const assetsDirectoryName = `${path.parse(markdownFilePath).name}.assets`;
  const downloadedImages = await mapWithConcurrencyLimit(slide.images, SLIDE_IMAGE_DOWNLOAD_CONCURRENCY, async (image, imageIndex) => {
    try {
      const asset = await downloadAssetWithCache(fetchImpl, image, downloadCache);
      return {
        ...image,
        ...asset,
        imageIndex
      };
    } catch (error) {
      return {
        ...image,
        imageIndex,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });

  for (const image of downloadedImages) {
    if (lines.length > 0) {
      lines.push("");
    }

    if ("error" in image) {
      lines.push(`<!-- ${image.error} -->`);
      continue;
    }

    let imageReference: string;
    if (assetMode === "data-uri") {
      imageReference = buildDataUri(image.bytes, image.mimeType);
    } else {
      const dedupeKey = `${image.mimeType}:${image.contentHash}`;
      const existingRelativePath = assetPathByContentHash.get(dedupeKey);
      const extension = contentTypeToExtension(image.mimeType);
      const relativePath =
        existingRelativePath ||
        normalizeRelativePath(
          path.join(
            assetsDirectoryName,
            buildDeduplicatedAssetFileName(
              buildAssetFileNameBase(slideIndex, image.imageIndex + 1, image.altText),
              extension,
              image.contentHash
            )
          )
        );

      if (!existingRelativePath) {
        assetPathByContentHash.set(dedupeKey, relativePath);
        assets.push({
          relativePath,
          bytes: image.bytes,
          mimeType: image.mimeType,
          contentHash: image.contentHash
        });
      }

      imageReference = toMarkdownAssetPath(relativePath);
    }

    lines.push(`![${image.altText}](${imageReference})`);
  }

  if (lines.length === 0) {
    lines.push(`<!-- Slide ${slideIndex} -->`);
  }

  return lines.join("\n").trimEnd();
}

export async function convertSlidesApiPresentationToMarp(
  markdownFilePath: string,
  presentation: SlidesApiPresentation,
  options: PresentationConversionOptions = {},
  fetchImpl: FetchLike = fetch
): Promise<PresentationMarkdownResult> {
  const assetMode = options.assetMode || "external";
  const slides = (presentation.slides || []).filter((slide) => !slide.slideProperties?.isSkipped);
  if (slides.length === 0) {
    throw new Error("Google Slides API did not return any visible slides.");
  }

  const parsedSlides = slides.map((slide, index) =>
    parseSlide(slide, index + 1, {
      includeBackgrounds: options.includeBackgrounds
    })
  );
  const deckTitle = options.title || presentation.title || parsedSlides.find((slide) => slide.title)?.title || path.parse(markdownFilePath).name;
  const assets: GeneratedFilePayload[] = [];
  const downloadCache = new Map<string, Promise<DownloadedSlideImage>>();
  const assetPathByContentHash = new Map<string, string>();
  let completedSlides = 0;
  const slideMarkdown = (
    await mapWithConcurrencyLimit(parsedSlides, SLIDE_RENDER_CONCURRENCY, async (slide, index) => {
      const renderedSlide = await renderSlideMarkdown(
        slide,
        index + 1,
        markdownFilePath,
        assets,
        assetMode,
        fetchImpl,
        downloadCache,
        assetPathByContentHash
      );
      completedSlides += 1;
      options.onProgress?.(completedSlides, parsedSlides.length);
      return renderedSlide;
    })
  )
    .join("\n\n---\n\n")
    .trimEnd();

  const fallbackNotice = "<!-- Generated via Google Slides API fallback because Drive export was too large. -->";

  return {
    markdown: `${buildFrontmatter(deckTitle)}\n\n${fallbackNotice}\n\n${slideMarkdown}\n`,
    assets,
    generatedAssetPaths: assets.map((asset) => asset.relativePath),
    slideCount: parsedSlides.length
  };
}
