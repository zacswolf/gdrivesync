import path from "node:path";

import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

import { GeneratedFilePayload } from "./types";
import { sha256Bytes } from "./utils/hash";
import { slugifyForFileName } from "./utils/paths";

type AssetMode = "external" | "data-uri";

interface PresentationConversionOptions {
  assetMode?: AssetMode;
  title?: string;
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
}

interface SlideTextBlock {
  placeholderType?: string;
  paragraphs: SlideParagraph[];
}

interface SlideImage {
  altText: string;
  mimeType: string;
  bytes: Uint8Array;
}

interface ParsedSlide {
  title?: string;
  bodyBlocks: string[][];
  images: SlideImage[];
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  trimValues: false
});

const TITLE_PLACEHOLDER_TYPES = new Set(["title", "ctrTitle"]);
const BODY_PLACEHOLDER_TYPES = new Set(["body", "subTitle", "obj"]);

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function normalizeZipPath(baseDirectory: string, target: string): string {
  return path.posix.normalize(path.posix.join(baseDirectory, target));
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function toMarkdownAssetPath(relativePath: string): string {
  return relativePath.startsWith("./") ? relativePath : `./${relativePath}`;
}

function parseXml<T>(rawXml: string): T {
  return xmlParser.parse(rawXml) as T;
}

async function readZipText(zip: JSZip, filePath: string): Promise<string> {
  const file = zip.file(filePath);
  if (!file) {
    throw new Error(`Presentation file is missing ${filePath}.`);
  }

  return file.async("text");
}

async function tryReadZipText(zip: JSZip, filePath: string): Promise<string | undefined> {
  const file = zip.file(filePath);
  if (!file) {
    return undefined;
  }

  return file.async("text");
}

async function readZipBytes(zip: JSZip, filePath: string): Promise<Uint8Array> {
  const file = zip.file(filePath);
  if (!file) {
    throw new Error(`Presentation file is missing ${filePath}.`);
  }

  return file.async("uint8array");
}

function buildRelationshipMap(relationshipRoot: unknown, baseDirectory: string): Map<string, string> {
  const relationshipMap = new Map<string, string>();
  const relationships = asArray(
    (relationshipRoot as { Relationships?: { Relationship?: unknown } } | undefined)?.Relationships?.Relationship
  );
  for (const relationship of relationships) {
    if (!relationship || typeof relationship !== "object") {
      continue;
    }

    const entry = relationship as Record<string, unknown>;
    if (typeof entry.Id !== "string" || typeof entry.Target !== "string") {
      continue;
    }

    relationshipMap.set(entry.Id, normalizeZipPath(baseDirectory, entry.Target));
  }

  return relationshipMap;
}

function collectParagraphText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!node || typeof node !== "object") {
    return "";
  }

  if (Array.isArray(node)) {
    return node.map((item) => collectParagraphText(item)).join("");
  }

  const objectValue = node as Record<string, unknown>;
  if (typeof objectValue["a:t"] === "string") {
    return objectValue["a:t"] as string;
  }

  return Object.entries(objectValue)
    .filter(([key]) => !key.includes(":") || key === "a:r" || key === "a:t" || key === "a:br")
    .map(([, value]) => collectParagraphText(value))
    .join("");
}

function extractShapeTextBlock(shape: unknown): SlideTextBlock | undefined {
  if (!shape || typeof shape !== "object") {
    return undefined;
  }

  const shapeRecord = shape as Record<string, unknown>;
  const placeholderType = (
    (shapeRecord["p:nvSpPr"] as Record<string, unknown> | undefined)?.["p:nvPr"] as Record<string, unknown> | undefined
  )?.["p:ph"] as Record<string, unknown> | undefined;
  const typeValue = typeof placeholderType?.type === "string" ? placeholderType.type : undefined;
  const paragraphs = asArray(
    (shapeRecord["p:txBody"] as Record<string, unknown> | undefined)?.["a:p"]
  )
    .map((paragraph): SlideParagraph | undefined => {
      if (!paragraph || typeof paragraph !== "object") {
        return undefined;
      }

      const paragraphRecord = paragraph as Record<string, unknown>;
      const text = collectParagraphText(paragraph).replace(/\s+/g, " ").trim();
      if (!text) {
        return undefined;
      }

      const rawLevel = ((paragraphRecord["a:pPr"] as Record<string, unknown> | undefined)?.lvl);
      const parsedLevel =
        typeof rawLevel === "string" && rawLevel.trim() !== "" && Number.isFinite(Number(rawLevel))
          ? Number(rawLevel)
          : undefined;

      return {
        text,
        level: parsedLevel
      };
    })
    .filter((paragraph): paragraph is SlideParagraph => Boolean(paragraph));

  if (paragraphs.length === 0) {
    return undefined;
  }

  return {
    placeholderType: typeValue,
    paragraphs
  };
}

function extensionToMimeType(extension: string): string {
  switch (extension.toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".bmp":
      return "image/bmp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function buildDataUri(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function formatTextBlock(block: SlideTextBlock): string[] {
  const paragraphs = block.paragraphs.filter((paragraph) => paragraph.text.trim() !== "");
  if (paragraphs.length === 0) {
    return [];
  }

  const shouldRenderAsList =
    block.placeholderType !== undefined &&
    BODY_PLACEHOLDER_TYPES.has(block.placeholderType) &&
    (paragraphs.length > 1 || paragraphs.some((paragraph) => paragraph.level !== undefined));

  if (!shouldRenderAsList) {
    return paragraphs.map((paragraph) => paragraph.text);
  }

  return paragraphs.map((paragraph) => `${"  ".repeat(paragraph.level ?? 0)}- ${paragraph.text}`);
}

function buildAssetFileNameBase(slideIndex: number, imageIndex: number, altText: string): string {
  const suffix = slugifyForFileName(altText || `image-${imageIndex}`);
  return `slide-${slideIndex}-${suffix}`;
}

async function parseSlide(
  zip: JSZip,
  slidePath: string,
  slideIndex: number
): Promise<ParsedSlide> {
  const slideXml = parseXml<Record<string, unknown>>(await readZipText(zip, slidePath));
  const slideRelsPath = path.posix.join(path.posix.dirname(slidePath), "_rels", `${path.posix.basename(slidePath)}.rels`);
  const slideRelsXml = await tryReadZipText(zip, slideRelsPath);
  const slideRelationshipMap = slideRelsXml
    ? buildRelationshipMap(parseXml(slideRelsXml), path.posix.dirname(slidePath))
    : new Map<string, string>();
  const spTree = ((slideXml["p:sld"] as Record<string, unknown> | undefined)?.["p:cSld"] as Record<string, unknown> | undefined)
    ?.["p:spTree"] as Record<string, unknown> | undefined;
  if (!spTree) {
    throw new Error(`Presentation slide ${slideIndex} is missing slide content.`);
  }

  const textBlocks = asArray(spTree["p:sp"])
    .map((shape) => extractShapeTextBlock(shape))
    .filter((block): block is SlideTextBlock => Boolean(block));

  const titleBlockIndex = textBlocks.findIndex((block) => block.placeholderType && TITLE_PLACEHOLDER_TYPES.has(block.placeholderType));
  const title =
    titleBlockIndex >= 0
      ? textBlocks[titleBlockIndex].paragraphs.map((paragraph) => paragraph.text).join(" ")
      : undefined;

  const bodyBlocks = textBlocks
    .filter((_, index) => index !== titleBlockIndex)
    .map((block) => formatTextBlock(block))
    .filter((block) => block.length > 0);

  const images: SlideImage[] = [];
  for (const [imageIndex, picture] of asArray(spTree["p:pic"]).entries()) {
    if (!picture || typeof picture !== "object") {
      continue;
    }

    const pictureRecord = picture as Record<string, unknown>;
    const embedId = (
      (pictureRecord["p:blipFill"] as Record<string, unknown> | undefined)?.["a:blip"] as Record<string, unknown> | undefined
    )?.["r:embed"];
    if (typeof embedId !== "string") {
      continue;
    }

    const mediaPath = slideRelationshipMap.get(embedId);
    if (!mediaPath) {
      continue;
    }

    const bytes = await readZipBytes(zip, mediaPath);
    const extension = path.extname(mediaPath) || ".png";
    const mimeType = extensionToMimeType(extension);
    const cNvPr = (pictureRecord["p:nvPicPr"] as Record<string, unknown> | undefined)?.["p:cNvPr"] as
      | Record<string, unknown>
      | undefined;
    const altTextCandidate =
      typeof cNvPr?.descr === "string" && cNvPr.descr.trim() !== ""
        ? cNvPr.descr
        : typeof cNvPr?.name === "string" && cNvPr.name.trim() !== ""
          ? cNvPr.name
          : `Slide ${slideIndex} image ${imageIndex + 1}`;

    images.push({
      altText: altTextCandidate,
      mimeType,
      bytes
    });
  }

  return {
    title,
    bodyBlocks,
    images
  };
}

async function getSlidePaths(zip: JSZip): Promise<string[]> {
  const presentationXml = parseXml<Record<string, unknown>>(await readZipText(zip, "ppt/presentation.xml"));
  const presentationRels = parseXml<Record<string, unknown>>(await readZipText(zip, "ppt/_rels/presentation.xml.rels"));
  const relationshipMap = buildRelationshipMap(presentationRels, "ppt");
  const slideIds = asArray(
    ((presentationXml["p:presentation"] as Record<string, unknown> | undefined)?.["p:sldIdLst"] as
      | Record<string, unknown>
      | undefined)?.["p:sldId"]
  );
  const slidePaths = slideIds
    .map((slideId) => (slideId && typeof slideId === "object" ? (slideId as Record<string, unknown>)["r:id"] : undefined))
    .filter((relationId): relationId is string => typeof relationId === "string")
    .map((relationId) => relationshipMap.get(relationId))
    .filter((slidePath): slidePath is string => typeof slidePath === "string");

  if (slidePaths.length === 0) {
    throw new Error("Presentation export did not include any slides.");
  }

  return slidePaths;
}

function renderSlideMarkdown(
  slide: ParsedSlide,
  slideIndex: number,
  markdownFilePath: string,
  assets: GeneratedFilePayload[],
  assetMode: AssetMode
): string {
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
  for (const [imageIndex, image] of slide.images.entries()) {
    if (lines.length > 0) {
      lines.push("");
    }

    let imageReference: string;
    if (assetMode === "data-uri") {
      imageReference = buildDataUri(image.bytes, image.mimeType);
    } else {
      const extension =
        image.mimeType === "image/jpeg"
          ? ".jpg"
          : image.mimeType === "image/svg+xml"
            ? ".svg"
            : `.${image.mimeType.split("/")[1]?.replace(/[^a-z0-9]+/gi, "-") || "png"}`;
      const fileName = `${buildAssetFileNameBase(slideIndex, imageIndex + 1, image.altText)}${extension}`;
      const relativePath = normalizeRelativePath(path.join(assetsDirectoryName, fileName));
      assets.push({
        relativePath,
        bytes: image.bytes,
        mimeType: image.mimeType,
        contentHash: sha256Bytes(image.bytes)
      });
      imageReference = toMarkdownAssetPath(relativePath);
    }

    lines.push(`![${image.altText}](${imageReference})`);
  }

  return lines.join("\n").trimEnd();
}

function buildFrontmatter(deckTitle: string): string {
  return ["---", "marp: true", "theme: default", "paginate: true", `title: ${JSON.stringify(deckTitle)}`, "---"].join("\n");
}

export async function convertPresentationToMarp(
  markdownFilePath: string,
  pptxBytes: Uint8Array,
  options: PresentationConversionOptions = {}
): Promise<PresentationMarkdownResult> {
  const assetMode = options.assetMode || "external";
  const zip = await JSZip.loadAsync(Buffer.from(pptxBytes));
  const slidePaths = await getSlidePaths(zip);
  const parsedSlides = await Promise.all(slidePaths.map((slidePath, index) => parseSlide(zip, slidePath, index + 1)));
  const deckTitle = options.title || parsedSlides.find((slide) => slide.title)?.title || path.parse(markdownFilePath).name;
  const assets: GeneratedFilePayload[] = [];
  const slideMarkdown = parsedSlides
    .map((slide, index) => renderSlideMarkdown(slide, index + 1, markdownFilePath, assets, assetMode))
    .join("\n\n---\n\n")
    .trimEnd();

  return {
    markdown: `${buildFrontmatter(deckTitle)}\n\n${slideMarkdown}\n`,
    assets,
    generatedAssetPaths: assets.map((asset) => asset.relativePath),
    slideCount: parsedSlides.length
  };
}
