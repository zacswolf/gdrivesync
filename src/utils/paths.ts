import path from "node:path";

export function toManifestKey(folderPath: string, filePath: string): string {
  const relativePath = path.relative(folderPath, filePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Linked files must live inside an open workspace folder.");
  }

  return relativePath.split(path.sep).join("/");
}

export function fromManifestKey(folderPath: string, key: string): string {
  return path.join(folderPath, ...key.split("/"));
}

export function slugifyForFileName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "google-doc";
}
