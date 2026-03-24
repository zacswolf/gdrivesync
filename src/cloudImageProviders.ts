import { GeneratedFilePayload } from "./types";
import { RequestTimeoutError, fetchWithTimeout } from "./utils/fetchTimeout";
import { runWithConcurrency } from "./utils/runWithConcurrency";

export type CloudImageProvider = "openai" | "anthropic";
export type CloudCredentialSource = "environment" | "keychain" | "secret-storage" | "missing";
export type ImageEnrichmentProviderName = "apple-vision" | "tesseract" | CloudImageProvider;

export interface ResolvedCloudApiKey {
  provider: CloudImageProvider;
  apiKey?: string;
  source: CloudCredentialSource;
}

export interface CloudImageEnrichmentRequest {
  asset: GeneratedFilePayload;
  currentAltText: string;
}

export interface CloudImageEnrichmentResult {
  contentHash: string;
  altText?: string;
  detail?: string;
  useful: boolean;
}

export interface CloudImageEnrichmentBatchResult {
  results: Map<string, CloudImageEnrichmentResult>;
  failureMessages: string[];
}

export interface CloudImageKeyResolver {
  resolve(provider: CloudImageProvider): Promise<ResolvedCloudApiKey>;
}

export interface CloudImageInferenceClient {
  enrichImages(
    provider: CloudImageProvider,
    apiKey: string,
    model: string,
    requests: CloudImageEnrichmentRequest[]
  ): Promise<CloudImageEnrichmentBatchResult>;
  testProvider(provider: CloudImageProvider, apiKey: string, model: string): Promise<void>;
}

const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const CLOUD_DETAIL_MAX_LENGTH = 500;
const CLOUD_ALT_MAX_LENGTH = 140;
const REQUEST_CONCURRENCY = 2;
const DEFAULT_CLOUD_REQUEST_TIMEOUT_MS = 30_000;

function normalizeWhitespace(value: string | undefined): string {
  if (!value) {
    return "";
  }

  return value.replace(/\s+/g, " ").trim();
}

function clipText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildSharedPrompt(currentAltText: string): string {
  return [
    "You are improving Markdown image descriptions for a Google Drive sync tool.",
    `Current alt text: ${currentAltText || "(empty)"}`,
    "Return JSON only with this exact shape:",
    '{"altText":"string","detail":"string","useful":true}',
    "Rules:",
    "- altText must be concise, useful, and at most 140 characters.",
    "- detail must be concise, useful for AI agents, and at most 500 characters.",
    "- If the image is decorative, logo-only, or does not have meaningful content, return useful=false and empty strings for altText and detail.",
    "- Prefer visible text that matters, but summarize what the image is rather than copying noise.",
    "- Never mention file names, slide numbers, or markdown syntax."
  ].join("\n");
}

function extractJsonObject(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Cloud image enrichment response did not contain a JSON object.");
  }

  return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
}

function normalizeCloudResult(contentHash: string, rawValue: unknown): CloudImageEnrichmentResult {
  if (!rawValue || typeof rawValue !== "object") {
    throw new Error("Cloud image enrichment returned malformed JSON.");
  }

  const payload = rawValue as Record<string, unknown>;
  const useful = payload.useful === true;
  const altText = clipText(normalizeWhitespace(typeof payload.altText === "string" ? payload.altText : ""), CLOUD_ALT_MAX_LENGTH);
  const detail = clipText(normalizeWhitespace(typeof payload.detail === "string" ? payload.detail : ""), CLOUD_DETAIL_MAX_LENGTH);

  return {
    contentHash,
    useful: useful && Boolean(altText),
    altText: useful ? altText : undefined,
    detail: useful && detail ? detail : undefined
  };
}

function parseOpenAiOutput(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const textChunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as Array<Record<string, unknown>> : [];
    for (const block of content) {
      if (block?.type === "output_text" && typeof block.text === "string") {
        textChunks.push(block.text);
      }
    }
  }

  return textChunks.join("\n").trim();
}

function parseAnthropicOutput(payload: Record<string, unknown>): string {
  const content = Array.isArray(payload.content) ? payload.content as Array<Record<string, unknown>> : [];
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

async function callOpenAi(
  fetchImpl: typeof fetch,
  requestTimeoutMs: number,
  apiKey: string,
  model: string,
  request: CloudImageEnrichmentRequest
): Promise<CloudImageEnrichmentResult> {
  const imageDataUrl = `data:${request.asset.mimeType};base64,${Buffer.from(request.asset.bytes).toString("base64")}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      OPENAI_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: buildSharedPrompt(request.currentAltText)
                },
                {
                  type: "input_image",
                  image_url: imageDataUrl
                }
              ]
            }
          ]
        })
      },
      requestTimeoutMs,
      "OpenAI image enrichment request timed out."
    );
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      throw new Error(error.message);
    }
    throw error;
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${detail || response.statusText}`);
  }

  const payload = await response.json() as Record<string, unknown>;
  return normalizeCloudResult(request.asset.contentHash, extractJsonObject(parseOpenAiOutput(payload)));
}

async function callAnthropic(
  fetchImpl: typeof fetch,
  requestTimeoutMs: number,
  apiKey: string,
  model: string,
  request: CloudImageEnrichmentRequest
): Promise<CloudImageEnrichmentResult> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      ANTHROPIC_ENDPOINT,
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          max_tokens: 300,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: buildSharedPrompt(request.currentAltText)
                },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: request.asset.mimeType,
                    data: Buffer.from(request.asset.bytes).toString("base64")
                  }
                }
              ]
            }
          ]
        })
      },
      requestTimeoutMs,
      "Anthropic image enrichment request timed out."
    );
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      throw new Error(error.message);
    }
    throw error;
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Anthropic request failed (${response.status}): ${detail || response.statusText}`);
  }

  const payload = await response.json() as Record<string, unknown>;
  return normalizeCloudResult(request.asset.contentHash, extractJsonObject(parseAnthropicOutput(payload)));
}

async function testOpenAi(fetchImpl: typeof fetch, requestTimeoutMs: number, apiKey: string, model: string): Promise<void> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      OPENAI_ENDPOINT,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: 'Reply with exactly {"ok":true}.'
                }
              ]
            }
          ]
        })
      },
      requestTimeoutMs,
      "OpenAI test request timed out."
    );
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      throw new Error(error.message);
    }
    throw error;
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${detail || response.statusText}`);
  }
}

async function testAnthropic(fetchImpl: typeof fetch, requestTimeoutMs: number, apiKey: string, model: string): Promise<void> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      ANTHROPIC_ENDPOINT,
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          max_tokens: 32,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: 'Reply with exactly {"ok":true}.'
                }
              ]
            }
          ]
        })
      },
      requestTimeoutMs,
      "Anthropic test request timed out."
    );
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      throw new Error(error.message);
    }
    throw error;
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Anthropic request failed (${response.status}): ${detail || response.statusText}`);
  }
}

export function getDefaultCloudModel(provider: CloudImageProvider): string {
  return provider === "openai" ? "gpt-5.4-nano" : "claude-haiku-4-5";
}

export function resolveCloudModel(provider: CloudImageProvider, override?: string): string {
  return override?.trim() || getDefaultCloudModel(provider);
}

export function formatCloudProviderLabel(provider: CloudImageProvider): string {
  return provider === "openai" ? "OpenAI" : "Anthropic";
}

export class HttpCloudImageInferenceClient implements CloudImageInferenceClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestTimeoutMs = DEFAULT_CLOUD_REQUEST_TIMEOUT_MS
  ) {}

  async enrichImages(
    provider: CloudImageProvider,
    apiKey: string,
    model: string,
    requests: CloudImageEnrichmentRequest[]
  ): Promise<CloudImageEnrichmentBatchResult> {
    const results = new Map<string, CloudImageEnrichmentResult>();
    const failureMessages: string[] = [];

    await runWithConcurrency(requests, REQUEST_CONCURRENCY, async (request) => {
      try {
        const result =
          provider === "openai"
            ? await callOpenAi(this.fetchImpl, this.requestTimeoutMs, apiKey, model, request)
            : await callAnthropic(this.fetchImpl, this.requestTimeoutMs, apiKey, model, request);
        results.set(request.asset.contentHash, result);
      } catch (error) {
        failureMessages.push(error instanceof Error ? error.message : String(error));
      }
    });

    return {
      results,
      failureMessages: [...new Set(failureMessages)]
    };
  }

  async testProvider(provider: CloudImageProvider, apiKey: string, model: string): Promise<void> {
    if (provider === "openai") {
      await testOpenAi(this.fetchImpl, this.requestTimeoutMs, apiKey, model);
      return;
    }

    await testAnthropic(this.fetchImpl, this.requestTimeoutMs, apiKey, model);
  }
}
