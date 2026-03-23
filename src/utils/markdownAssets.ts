import path from "node:path";

import { GeneratedMarkdownAsset } from "../types";
import { slugifyForFileName } from "./paths";

const REFERENCE_DATA_IMAGE_PATTERN =
  /^\[([^\]]+)\]:\s*<?data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)>?\s*$/gm;
const IMAGE_REFERENCE_USAGE_PATTERN = /!\[([^\]]*)\]\[([^\]]+)\]/g;
const IMAGE_SHORTCUT_REFERENCE_PATTERN = /!\[([^\]]+)\](?!\()/g;
const INLINE_DATA_IMAGE_PATTERN = /!\[([^\]]*)\]\(data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)\)/g;
const EMBEDDED_DATA_IMAGE_PATTERN = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/;

export interface MarkdownAssetExtractionResult {
  markdown: string;
  assets: GeneratedMarkdownAsset[];
  generatedAssetPaths: string[];
}

function getAssetsDirectoryName(markdownFilePath: string): string {
  return `${path.parse(markdownFilePath).name}.assets`;
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function toMarkdownAssetPath(relativePath: string): string {
  return relativePath.startsWith("./") ? relativePath : `./${relativePath}`;
}

function getImageExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.toLowerCase() || "bin";
  if (subtype === "jpeg") {
    return "jpg";
  }
  if (subtype === "svg+xml") {
    return "svg";
  }
  if (subtype === "x-icon" || subtype === "vnd.microsoft.icon") {
    return "ico";
  }

  return subtype.replace(/[^a-z0-9]+/g, "-") || "bin";
}

function buildUniqueFileName(preferredBaseName: string, mimeType: string, usedFileNames: Set<string>): string {
  const extension = getImageExtension(mimeType);
  const baseName = slugifyForFileName(preferredBaseName || "image");
  let candidate = `${baseName}.${extension}`;
  let index = 2;
  while (usedFileNames.has(candidate)) {
    candidate = `${baseName}-${index}.${extension}`;
    index += 1;
  }

  usedFileNames.add(candidate);
  return candidate;
}

export function containsEmbeddedImageData(markdown: string): boolean {
  return EMBEDDED_DATA_IMAGE_PATTERN.test(markdown);
}

export function extractMarkdownAssets(markdownFilePath: string, markdown: string): MarkdownAssetExtractionResult {
  const assetsDirectoryName = getAssetsDirectoryName(markdownFilePath);
  const usedFileNames = new Set<string>();
  const assetsByPayload = new Map<string, string>();
  const referencePaths = new Map<string, string>();
  const assets: GeneratedMarkdownAsset[] = [];

  function materializeAsset(preferredBaseName: string, mimeType: string, base64Value: string): string {
    const payloadKey = `${mimeType}:${base64Value}`;
    const existingRelativePath = assetsByPayload.get(payloadKey);
    if (existingRelativePath) {
      return existingRelativePath;
    }

    const fileName = buildUniqueFileName(preferredBaseName, mimeType, usedFileNames);
    const relativePath = normalizeRelativePath(path.join(assetsDirectoryName, fileName));
    const bytes = Uint8Array.from(Buffer.from(base64Value, "base64"));
    assets.push({
      relativePath,
      bytes,
      mimeType
    });
    assetsByPayload.set(payloadKey, relativePath);
    return relativePath;
  }

  let nextMarkdown = markdown.replace(REFERENCE_DATA_IMAGE_PATTERN, (_, label: string, mimeType: string, base64Value: string) => {
    const relativePath = materializeAsset(label, mimeType, base64Value);
    referencePaths.set(label, relativePath);
    return "";
  });

  nextMarkdown = nextMarkdown.replace(IMAGE_REFERENCE_USAGE_PATTERN, (_, altText: string, label: string) => {
    const relativePath = referencePaths.get(label);
    if (!relativePath) {
      return `![${altText}][${label}]`;
    }

    const effectiveAltText = altText || label;
    return `![${effectiveAltText}](${toMarkdownAssetPath(relativePath)})`;
  });

  nextMarkdown = nextMarkdown.replace(IMAGE_SHORTCUT_REFERENCE_PATTERN, (fullMatch: string, label: string) => {
    const relativePath = referencePaths.get(label);
    if (!relativePath) {
      return fullMatch;
    }

    return `![${label}](${toMarkdownAssetPath(relativePath)})`;
  });

  nextMarkdown = nextMarkdown.replace(
    INLINE_DATA_IMAGE_PATTERN,
    (_, altText: string, mimeType: string, base64Value: string) => {
      const relativePath = materializeAsset(altText || "image", mimeType, base64Value);
      const effectiveAltText = altText || "image";
      return `![${effectiveAltText}](${toMarkdownAssetPath(relativePath)})`;
    }
  );

  nextMarkdown = nextMarkdown.replace(/\n{3,}/g, "\n\n").trimEnd();

  return {
    markdown: nextMarkdown,
    assets,
    generatedAssetPaths: assets.map((asset) => asset.relativePath)
  };
}
