export class RequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string
): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  let timedOut = false;

  const relayAbort = () => controller.abort();
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort();
    } else {
      upstreamSignal.addEventListener("abort", relayAbort, { once: true });
    }
  }

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImpl(input, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (timedOut && isAbortError(error)) {
      throw new RequestTimeoutError(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
    upstreamSignal?.removeEventListener("abort", relayAbort);
  }
}
