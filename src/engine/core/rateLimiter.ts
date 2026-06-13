/**
 * Outgoing request rate limiting and rate-limit retry, applied to every model
 * call as an AI SDK language-model middleware (wired in core/models.ts). It
 * sits *below* Mastra, so the error it sees on a throttled request is the raw
 * provider `APICallError` (HTTP 429), before Mastra wraps it into a step error.
 *
 * Two behaviours, both per provider:
 *   - Throttle: when `myDevTeam.provider.requestsPerMinute` is set, calls are
 *     spaced so a provider never receives more than that many requests per
 *     rolling minute. Keeps a run under a provider's quota (e.g. Groq's free
 *     tier) instead of firing requests until one is rejected.
 *   - Retry: a 429 is caught and retried after the delay the provider suggests
 *     (its `retry-after` header, or the "try again in Ns" hint in the message),
 *     up to `provider.maxRateLimitRetries` times. The throttle slot is
 *     re-acquired before each attempt, so retries also stay within the budget.
 *
 * Both read their settings live, so changing the limit takes effect on the next
 * request without rebuilding the wrapped model.
 */
import { APICallError, LanguageModelMiddleware } from 'ai';
import { settings } from '../../config/settings';

/**
 * The next time, per provider, a request may be sent (epoch ms). Spacing is
 * `60_000 / rpm` apart; a burst queues onto successive slots rather than all
 * going out at once. Module state so the budget is shared across every agent
 * and run that talks to the same provider.
 */
const nextSlot = new Map<string, number>();

/**
 * Reserve the next send slot for `key` and return how long (ms) to wait before
 * using it. `now` is injectable for tests. With throttling off (`rpm <= 0`)
 * there is no wait and no slot is consumed.
 */
export function reserveSlot(key: string, rpm: number, now: number = Date.now()): number {
  if (rpm <= 0) {
    return 0;
  }
  const interval = 60_000 / rpm;
  const earliest = Math.max(now, nextSlot.get(key) ?? 0);
  nextSlot.set(key, earliest + interval);
  return earliest - now;
}

/** Drop all reserved slots - used by tests to isolate the shared state. */
export function __resetRateLimiter(): void {
  nextSlot.clear();
}

/** A cancellable sleep: rejects with the abort reason if the signal fires. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Whether an error is a provider rate-limit rejection (HTTP 429). */
function isRateLimitError(error: unknown): error is APICallError {
  return APICallError.isInstance(error) && error.statusCode === 429;
}

/**
 * The retry delay a 429 response suggests, in ms, or undefined when it carries
 * none. Reads the standard `retry-after-ms` / `retry-after` headers (seconds or
 * an HTTP date), then falls back to parsing the provider's "try again in Ns"
 * message (Groq phrases its limit this way, e.g. "try again in 3.465s").
 */
export function suggestedDelayMs(error: APICallError): number | undefined {
  const headers = error.responseHeaders ?? {};
  const ms = Number(headers['retry-after-ms']);
  if (Number.isFinite(ms) && ms >= 0) {
    return ms;
  }
  const after = headers['retry-after'];
  if (after) {
    const seconds = Number(after);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }
    const date = Date.parse(after);
    if (Number.isFinite(date)) {
      return Math.max(0, date - Date.now());
    }
  }
  const match = /try again in ([\d.]+)\s*(ms|s)/i.exec(error.message);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      return match[2].toLowerCase() === 'ms' ? value : value * 1000;
    }
  }
  return undefined;
}

/**
 * How long to wait before retrying a rate-limited request on this `attempt`
 * (0-based), or undefined when the error is not a retryable rate limit. Prefers
 * the provider's suggested delay (plus a small buffer, since it is
 * approximate); otherwise backs off exponentially. Always clamped to
 * `provider.maxRetryWaitMs`.
 */
export function rateLimitRetryDelayMs(error: unknown, attempt: number): number | undefined {
  if (!isRateLimitError(error)) {
    return undefined;
  }
  const max = settings.provider.maxRetryWaitMs;
  const suggested = suggestedDelayMs(error);
  const wait =
    suggested !== undefined
      ? suggested + settings.provider.retryBufferMs
      : 1000 * 2 ** attempt;
  return Math.min(max, Math.max(0, wait));
}

/**
 * Run `operation` for `provider`, throttling to the configured RPM and
 * retrying a 429 after its suggested delay. Used by both `wrapGenerate` and
 * `wrapStream`: the 429 surfaces when the request is made (before any stream
 * chunks), so wrapping the call itself catches it for streaming too.
 */
async function withRateLimit<T>(
  provider: string,
  operation: () => PromiseLike<T>,
  signal?: AbortSignal
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = reserveSlot(provider, settings.provider.requestsPerMinute);
    if (wait > 0) {
      await delay(wait, signal);
    }
    try {
      return await operation();
    } catch (error) {
      const retryIn = rateLimitRetryDelayMs(error, attempt);
      if (retryIn === undefined || attempt >= settings.provider.maxRateLimitRetries) {
        throw error;
      }
      console.warn(
        `[my-dev-team] ${provider} rate limited; retrying in ${Math.round(retryIn)}ms ` +
          `(attempt ${attempt + 1}/${settings.provider.maxRateLimitRetries}).`
      );
      await delay(retryIn, signal);
    }
  }
}

/** Whether an error means the request was throttled out of retries (a 429). */
export function isRateLimited(error: unknown): boolean {
  if (isRateLimitError(error)) {
    return true;
  }
  // Mastra serialises step errors to plain objects, so by the time a persistent
  // 429 reaches the engine's failure mapping it may be a string/object, not an
  // APICallError instance. Fall back to the message text.
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);
  return /rate limit|status code 429|\b429\b/i.test(message);
}

/** The rate-limiting middleware for one provider's wired models. */
export function rateLimitMiddleware(provider: string): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    wrapGenerate: ({ doGenerate, params }) =>
      withRateLimit(provider, doGenerate, params.abortSignal),
    wrapStream: ({ doStream, params }) =>
      withRateLimit(provider, doStream, params.abortSignal),
  };
}
