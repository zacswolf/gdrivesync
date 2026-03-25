import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const SITE_ROOT = resolve(process.cwd(), "site/public");
const DEFAULT_PORT = 4173;

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"]
]);

function parsePort() {
  const portFlagIndex = process.argv.indexOf("--port");
  if (portFlagIndex !== -1) {
    const value = Number(process.argv[portFlagIndex + 1]);
    if (Number.isInteger(value) && value > 0) {
      return value;
    }
  }

  const envPort = Number(process.env.PORT);
  if (Number.isInteger(envPort) && envPort > 0) {
    return envPort;
  }

  return DEFAULT_PORT;
}

function toSafePath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const normalized = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const candidate = resolve(SITE_ROOT, `.${normalized}`);
  if (!candidate.startsWith(SITE_ROOT)) {
    return null;
  }
  return candidate;
}

async function readCandidate(pathname) {
  const safePath = toSafePath(pathname);
  if (!safePath) {
    return null;
  }

  const candidates = [safePath];
  if (!extname(safePath)) {
    candidates.push(join(safePath, "index.html"));
  }

  for (const candidate of candidates) {
    try {
      const body = await readFile(candidate);
      return { body, path: candidate };
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "EISDIR")
      ) {
        continue;
      }
      throw error;
    }
  }

  return null;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const result = await readCandidate(url.pathname);
    if (!result) {
      const fallback = await readFile(join(SITE_ROOT, "404.html"));
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end(fallback);
      return;
    }

    const contentType = CONTENT_TYPES.get(extname(result.path)) || "application/octet-stream";
    response.writeHead(200, { "content-type": contentType });
    response.end(result.body);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(`Site preview error: ${error instanceof Error ? error.message : String(error)}`);
  }
});

const port = parsePort();
server.listen(port, "127.0.0.1", () => {
  console.log(`GDriveSync site preview: http://127.0.0.1:${port}/`);
});
