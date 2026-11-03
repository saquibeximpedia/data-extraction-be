/** A failure worth trying again: network errors, 429 and 5xx */
export class RetryableError extends Error {}

export interface GetJsonOptions {
  headers?: Record<string, string>;
  source?: string;
  /** Cancels the request (a stopped run); the abort error is thrown as is, not retried */
  signal?: AbortSignal;
  /** Gives up on a request that takes longer than this (retried as a temporary error) */
  timeoutMs?: number;
}

/**
 * GET a JSON endpoint. Throws RetryableError for 429/5xx, timeouts and network failures,
 * and a plain Error for other non-2xx responses (those won't be retried).
 */
export async function getJson<T = any>(url: string, options: GetJsonOptions = {}): Promise<T> {
  const source = options.source ?? new URL(url).host;
  const signals = [options.signal, options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined].filter((s): s is AbortSignal => !!s);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  // A stop is thrown as is; a timeout or dropped connection (also while reading the body) is retried
  const failed = (err: any) => {
    if (options.signal?.aborted) return options.signal.reason;
    if (err?.name === 'TimeoutError') return new RetryableError(`${source}: no response within ${options.timeoutMs! / 1000}s`);
    return new RetryableError(`${source}: network error (${err.message})`);
  };
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json', ...options.headers }, signal });
  } catch (err) {
    throw failed(err);
  }
  if (response.status === 429 || response.status >= 500) {
    throw new RetryableError(`${source}: temporary error HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`${source}: HTTP ${response.status} ${response.statusText}`);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw failed(err);
  }
  return JSON.parse(text) as T;
}

/**
 * Runs `fn`, retrying RetryableErrors with exponential backoff and jitter; a stopped run is not retried.
 * `onRetry` hears about each retry before its wait (attempt 1 is the first retry).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number,
  signal?: AbortSignal,
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RetryableError) || attempt >= maxRetries || signal?.aborted) throw err;
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
      onRetry?.(attempt + 1, delay, err);
      await sleep(delay, signal);
    }
  }
}

/** Waits `ms`, or throws as soon as `signal` aborts */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A browser-like User-Agent; some government endpoints reject default clients */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
