import http from "node:http";
import { AddressInfo } from "node:net";

export interface LocalCallbackServer {
  localRedirect: string;
  waitForCallback(timeoutMs?: number): Promise<URLSearchParams>;
  dispose(): Promise<void>;
}

function renderResponseHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body {
        font-family: ui-sans-serif, system-ui, sans-serif;
        background: #f7f5ef;
        color: #1f1f1f;
        padding: 48px 24px;
      }
      main {
        max-width: 42rem;
        margin: 0 auto;
        background: #fff;
        border-radius: 16px;
        padding: 32px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.08);
      }
      h1 {
        margin-top: 0;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${body}</p>
      <p>You can return to VS Code.</p>
    </main>
  </body>
</html>`;
}

export async function createLocalCallbackServer(pathname: string, title: string, body: string): Promise<LocalCallbackServer> {
  let resolveResult!: (params: URLSearchParams) => void;
  let rejectResult!: (error: Error) => void;
  let timeoutHandle: NodeJS.Timeout | undefined;

  const resultPromise = new Promise<URLSearchParams>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (requestUrl.pathname !== pathname) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderResponseHtml(title, body));
    clearTimeout(timeoutHandle);
    resolveResult(requestUrl.searchParams);
    server.close();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("Could not start the local callback server.");
  }

  return {
    localRedirect: `http://127.0.0.1:${address.port}${pathname}`,
    waitForCallback(timeoutMs = 180000) {
      timeoutHandle = setTimeout(() => {
        rejectResult(new Error("Timed out waiting for the browser callback."));
        server.close();
      }, timeoutMs);

      return resultPromise;
    },
    dispose() {
      clearTimeout(timeoutHandle);
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  };
}
