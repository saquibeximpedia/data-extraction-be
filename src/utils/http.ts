/** A failure worth trying again: network errors, 429 and 5xx */
export class RetryableError extends Error {}

/**
 * GET a JSON endpoint. Throws RetryableError for 429/5xx and network failures,
 * and a plain Error for other non-2xx responses (those won't be retried).
 */
export async function getJson<T = any>(url: string, options: { headers?: Record<string, string>; source?: string } = {}): Promise<T> {
  const source = options.source ?? new URL(url).host;
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json', ...options.headers } });
  } catch (err: any) {
    throw new RetryableError(`${source}: network error (${err.message})`);
  }
  if (response.status === 429 || response.status >= 500) {
    throw new RetryableError(`${source}: temporary error HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`${source}: HTTP ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/** Runs `fn`, retrying RetryableErrors with exponential backoff and jitter */
export async function withRetry<T>(fn: () => Promise<T>, maxRetries: number, baseDelayMs: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RetryableError) || attempt >= maxRetries) throw err;
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** A browser-like User-Agent; some government endpoints reject default clients */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
