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
 * A reserved send slot: how long to wait before using it, plus the bookkeeping
 * `releaseSlot` needs to hand the slot back if the wait is aborted before the
 * request ever goes out.
 */
interface SlotReservation {
  key: string;
  /** ms to wait before the slot is usable. */
  wait: number;
  /** The `nextSlot` value this reservation set (so a release can tell it is still the tail). */
  reserved: number;
  /** The `nextSlot` value before this reservation, to roll back to on release. */
  previous: number;
}

/**
 * Reserve the next send slot for `key`, returning the reservation. Spacing is
 * `60_000 / rpm`; a burst queues onto successive slots. With throttling off
 * (`rpm <= 0`) nothing is reserved and the wait is 0. `now` is injectable for
 * tests.
 */
function acquireSlot(key: string, rpm: number, now: number = Date.now()): SlotReservation {
  if (rpm <= 0) {
    return { key, wait: 0, reserved: 0, previous: 0 };
  }
  const interval = 60_000 / rpm;
  const previous = nextSlot.get(key) ?? 0;
  const earliest = Math.max(now, previous);
  const reserved = earliest + interval;
  nextSlot.set(key, reserved);
  return { key, wait: earliest - now, reserved, previous };
}

/**
 * Hand a reserved slot back when the request it was for never went out (the
 * throttle wait was aborted). Without this, a cancelled call still consumed its
 * slot and pushed every later call to the same provider needlessly further into
 * the future. The rollback only applies when no later reservation has advanced
 * past ours (`nextSlot` is still our value) - otherwise our slot is in the
 * middle of the queue and cannot be cleanly reclaimed, so it is left as spacing.
 * When the rollback empties the entry (our reservation was the first) it is
 * deleted, so an aborted first call leaves no lingering state.
 */
function releaseSlot(reservation: SlotReservation): void {
  if (reservation.reserved === 0 || nextSlot.get(reservation.key) !== reservation.reserved) {
    return;
  }
  if (reservation.previous === 0) {
    nextSlot.delete(reservation.key);
  } else {
    nextSlot.set(reservation.key, reservation.previous);
  }
}

/**
 * Reserve the next send slot for `key` and return how long (ms) to wait before
 * using it. `now` is injectable for tests. With throttling off (`rpm <= 0`)
 * there is no wait and no slot is consumed. A thin wrapper over `acquireSlot`
 * for callers (and tests) that only need the wait and never release the slot.
 */
export function reserveSlot(key: string, rpm: number, now: number = Date.now()): number {
  return acquireSlot(key, rpm, now).wait;
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
    const reservation = acquireSlot(provider, settings.provider.requestsPerMinute);
    if (reservation.wait > 0) {
      try {
        await delay(reservation.wait, signal);
      } catch (err) {
        // Aborted before the request went out: hand the slot back so a
        // cancelled call does not push the provider's queue out for the calls
        // behind it. (Once operation() below runs, the request was issued, so
        // its slot is legitimately spent and is never released.)
        releaseSlot(reservation);
        throw err;
      }
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
