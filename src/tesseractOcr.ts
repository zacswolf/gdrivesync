import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TesseractCapabilityReport {
  available: boolean;
  path?: string;
}

export interface TesseractOcrResult {
  path: string;
  text?: string;
  error?: string;
}

interface TesseractWordRow {
  level: number;
  pageNum: number;
  blockNum: number;
  paragraphNum: number;
  lineNum: number;
  wordNum: number;
  confidence: number;
  text: string;
}

const MIN_CONFIDENCE = 55;

async function resolveExecutablePath(command: string): Promise<string | undefined> {
  const locator = process.platform === "win32" ? "where" : "which";
  const args = process.platform === "win32" ? [command] : [command];

  try {
    const { stdout } = await execFileAsync(locator, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    const firstLine = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return firstLine || undefined;
  } catch {
    return undefined;
  }
}

export async function inspectTesseractCapability(): Promise<TesseractCapabilityReport> {
  const executablePath = await resolveExecutablePath("tesseract");
  return {
    available: Boolean(executablePath),
    path: executablePath
  };
}

export function parseTesseractTsv(rawValue: string): string {
  const rows = rawValue
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): TesseractWordRow | undefined => {
      const columns = line.split("\t");
      if (columns.length < 12) {
        return undefined;
      }

      const level = Number(columns[0]);
      const pageNum = Number(columns[1]);
      const blockNum = Number(columns[2]);
      const paragraphNum = Number(columns[3]);
      const lineNum = Number(columns[4]);
      const wordNum = Number(columns[5]);
      const confidence = Number(columns[10]);
      const text = columns.slice(11).join("\t").trim();
      if (
        !Number.isFinite(level) ||
        !Number.isFinite(pageNum) ||
        !Number.isFinite(blockNum) ||
        !Number.isFinite(paragraphNum) ||
        !Number.isFinite(lineNum) ||
        !Number.isFinite(wordNum) ||
        !Number.isFinite(confidence)
      ) {
        return undefined;
      }

      return {
        level,
        pageNum,
        blockNum,
        paragraphNum,
        lineNum,
        wordNum,
        confidence,
        text
      };
    })
    .filter((row): row is TesseractWordRow => Boolean(row))
    .filter((row) => row.level === 5 && row.text && row.confidence >= MIN_CONFIDENCE)
    .sort((left, right) => (
      left.pageNum - right.pageNum ||
      left.blockNum - right.blockNum ||
      left.paragraphNum - right.paragraphNum ||
      left.lineNum - right.lineNum ||
      left.wordNum - right.wordNum
    ));

  const lines = new Map<string, string[]>();
  for (const row of rows) {
    const lineKey = `${row.pageNum}:${row.blockNum}:${row.paragraphNum}:${row.lineNum}`;
    const values = lines.get(lineKey) || [];
    values.push(row.text);
    lines.set(lineKey, values);
  }

  return [...lines.values()]
    .map((words) => words.join(" ").trim())
    .filter(Boolean)
    .join("\n");
}

async function runTesseractOnImage(imagePath: string, executablePath: string): Promise<TesseractOcrResult> {
  try {
    const { stdout } = await execFileAsync(
      executablePath,
      [imagePath, "stdout", "-l", "eng", "--psm", "6", "quiet", "tsv"],
      {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024
      }
    );
    const text = parseTesseractTsv(stdout);
    return {
      path: path.resolve(imagePath),
      text: text || undefined
    };
  } catch (error) {
    return {
      path: path.resolve(imagePath),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function runTesseractOcr(
  imagePaths: string[],
  executablePath?: string
): Promise<Map<string, TesseractOcrResult>> {
  const resolvedExecutablePath = executablePath || (await resolveExecutablePath("tesseract"));
  if (!resolvedExecutablePath) {
    return new Map();
  }

  const results = await Promise.all(imagePaths.map((imagePath) => runTesseractOnImage(imagePath, resolvedExecutablePath)));
  return new Map(results.map((result) => [result.path, result]));
}
