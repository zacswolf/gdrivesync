import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  mode?: number;
}

function buildTemporaryPath(targetPath: string): string {
  return `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

export async function writeFileAtomically(
  targetPath: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });

  const temporaryPath = buildTemporaryPath(targetPath);
  try {
    if (typeof contents === "string") {
      await writeFile(temporaryPath, contents, {
        encoding: options.encoding || "utf8",
        mode: options.mode
      });
    } else {
      await writeFile(temporaryPath, contents, {
        mode: options.mode
      });
    }

    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
