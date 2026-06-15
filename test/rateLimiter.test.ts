import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { APICallError } from 'ai';
import {
  reserveSlot,
  suggestedDelayMs,
  rateLimitRetryDelayMs,
  isRateLimited,
  rateLimitMiddleware,
  __resetRateLimiter,
} from '../src/engine/core/rateLimiter';
import { __reset, __setConfig } from './mocks/vscode';

/** A provider 429, optionally carrying retry-after headers / a delay message. */
function rateLimitError(
  message = 'Rate limit reached.',
  headers: Record<string, string> = {}
): APICallError {
  return new APICallError({
    message,
    url: 'https://api.example.com',
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: headers,
    isRetryable: true,
  });
}

beforeEach(() => {
  __reset();
  __resetRateLimiter();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('suggestedDelayMs', () => {
  it('reads the retry-after-ms header', () => {
    expect(suggestedDelayMs(rateLimitError('x', { 'retry-after-ms': '1500' }))).toBe(1500);
  });

  it('reads retry-after as whole seconds', () => {
    expect(suggestedDelayMs(rateLimitError('x', { 'retry-after': '3' }))).toBe(3000);
  });

  it('reads retry-after as an HTTP date', () => {
    const when = new Date(Date.now() + 2000).toUTCString();
    const ms = suggestedDelayMs(rateLimitError('x', { 'retry-after': when }))!;
    // Whole-second date resolution, so allow a small window.
    expect(ms).toBeGreaterThan(900);
    expect(ms).toBeLessThanOrEqual(2000);
  });

  it('parses the "try again in Ns" hint Groq returns', () => {
    expect(suggestedDelayMs(rateLimitError('Please try again in 3.465s'))).toBeCloseTo(3465, 0);
  });

  it('parses a millisecond hint', () => {
    expect(suggestedDelayMs(rateLimitError('try again in 500ms'))).toBe(500);
  });

  it('returns undefined when nothing suggests a delay', () => {
    expect(suggestedDelayMs(rateLimitError('Rate limit reached.'))).toBeUndefined();
  });
});

describe('rateLimitRetryDelayMs', () => {
  it('is undefined for a non-429 error', () => {
    expect(rateLimitRetryDelayMs(new Error('boom'), 0)).toBeUndefined();
    const notRateLimited = new APICallError({
      message: 'bad request',
      url: 'u',
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    });
    expect(rateLimitRetryDelayMs(notRateLimited, 0)).toBeUndefined();
  });

  it('adds the buffer to a suggested delay', () => {
    // 3465ms suggested + 250ms buffer (the default retryBufferMs).
    expect(rateLimitRetryDelayMs(rateLimitError('try again in 3.465s'), 0)).toBe(3715);
  });

  it('backs off exponentially when no delay is suggested', () => {
    expect(rateLimitRetryDelayMs(rateLimitError(), 0)).toBe(1000);
    expect(rateLimitRetryDelayMs(rateLimitError(), 1)).toBe(2000);
    expect(rateLimitRetryDelayMs(rateLimitError(), 3)).toBe(8000);
  });

  it('clamps to the max retry wait', () => {
    // 120s suggested is clamped to the 60s cap (maxRetryWaitMs).
    expect(rateLimitRetryDelayMs(rateLimitError('try again in 120s'), 0)).toBe(60_000);
  });
});

describe('reserveSlot', () => {
  it('never waits when throttling is disabled', () => {
    expect(reserveSlot('groq', 0, 1000)).toBe(0);
    expect(reserveSlot('groq', 0, 1000)).toBe(0);
  });

  it('spaces requests evenly and queues a burst', () => {
    // 60 rpm -> one request per 1000ms.
    expect(reserveSlot('groq', 60, 1000)).toBe(0); // first goes immediately
    expect(reserveSlot('groq', 60, 1000)).toBe(1000); // next queued 1s out
    expect(reserveSlot('groq', 60, 1500)).toBe(1500); // third onto the 3s slot
  });

  it('keeps a separate budget per provider', () => {
    expect(reserveSlot('groq', 60, 1000)).toBe(0);
    // Ollama has its own slot, unaffected by Groq's reservation.
    expect(reserveSlot('ollama', 60, 1000)).toBe(0);
  });
});

describe('isRateLimited', () => {
  it('recognises a 429 APICallError', () => {
    expect(isRateLimited(rateLimitError())).toBe(true);
  });

  it('recognises a serialised rate-limit message', () => {
    expect(isRateLimited({ message: 'Rate limit reached for model, status code 429' })).toBe(true);
  });

  it('is false for unrelated errors', () => {
    expect(isRateLimited(new Error('connection refused'))).toBe(false);
    expect(isRateLimited('nope')).toBe(false);
  });
});

describe('rateLimitMiddleware', () => {
  it('retries a 429 after the suggested delay, then succeeds', async () => {
    vi.useFakeTimers();
    const mw = rateLimitMiddleware('groq');
    let calls = 0;
    const doGenerate = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw rateLimitError('try again in 1s');
      }
      return { value: 'ok' };
    });
    const promise = mw.wrapGenerate!({
      doGenerate,
      doStream: (async () => ({})) as any,
      params: {} as any,
      model: {} as any,
    });
    // Drain the 1s + buffer wait, then the second attempt resolves.
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toEqual({ value: 'ok' });
    expect(doGenerate).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured number of retries', async () => {
    vi.useFakeTimers();
    const mw = rateLimitMiddleware('groq');
    const doGenerate = vi.fn(async () => {
      throw rateLimitError('try again in 1s');
    });
    const promise = mw.wrapGenerate!({
      doGenerate,
      doStream: (async () => ({})) as any,
      params: {} as any,
      model: {} as any,
    });
    // Surface the eventual rejection without an unhandled-rejection warning.
    const settled = promise.catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await settled;
    expect(APICallError.isInstance(error)).toBe(true);
    // The initial attempt plus maxRateLimitRetries (5) retries.
    expect(doGenerate).toHaveBeenCalledTimes(6);
  });

  it('rethrows a non-rate-limit error immediately, without retrying', async () => {
    const mw = rateLimitMiddleware('groq');
    const doGenerate = vi.fn(async () => {
      throw new Error('model unreachable');
    });
    await expect(
      mw.wrapGenerate!({
        doGenerate,
        doStream: (async () => ({})) as any,
        params: {} as any,
        model: {} as any,
      })
    ).rejects.toThrow('model unreachable');
    expect(doGenerate).toHaveBeenCalledTimes(1);
  });

  it('throttles the second call when an RPM limit is set', async () => {
    vi.useFakeTimers();
    __setConfig('myDevTeam.provider.requestsPerMinute', 60); // 1 request / 1000ms
    const mw = rateLimitMiddleware('groq');
    const doGenerate = vi.fn(async () => ({ value: 'ok' }));
    const call = () =>
      mw.wrapGenerate!({
        doGenerate,
        doStream: (async () => ({})) as any,
        params: {} as any,
        model: {} as any,
      });

    await expect(call()).resolves.toEqual({ value: 'ok' }); // first goes immediately
    expect(doGenerate).toHaveBeenCalledTimes(1);

    const second = call(); // must wait ~1000ms for its slot
    await vi.advanceTimersByTimeAsync(500);
    expect(doGenerate).toHaveBeenCalledTimes(1); // still throttled
    await vi.advanceTimersByTimeAsync(600);
    await expect(second).resolves.toEqual({ value: 'ok' });
    expect(doGenerate).toHaveBeenCalledTimes(2);
  });

  it('hands a reserved slot back when the throttle wait is aborted', async () => {
    vi.useFakeTimers();
    __setConfig('myDevTeam.provider.requestsPerMinute', 60); // 1 request / 1000ms
    const mw = rateLimitMiddleware('groq');
    const doGenerate = vi.fn(async () => ({ value: 'ok' }));
    const call = (signal?: AbortSignal) =>
      mw.wrapGenerate!({
        doGenerate,
        doStream: (async () => ({})) as any,
        params: (signal ? { abortSignal: signal } : {}) as any,
        model: {} as any,
      });

    // First call consumes the immediate slot (reserves the 1000ms one next).
    await expect(call()).resolves.toEqual({ value: 'ok' });
    expect(doGenerate).toHaveBeenCalledTimes(1);

    // Second call must wait ~1000ms; abort it mid-wait. It should never issue
    // and should release the slot it reserved.
    const controller = new AbortController();
    const aborted = call(controller.signal).catch((e) => e);
    await vi.advanceTimersByTimeAsync(200);
    controller.abort(new Error('cancelled'));
    expect((await aborted).message).toBe('cancelled');
    expect(doGenerate).toHaveBeenCalledTimes(1); // never issued

    // The released slot was rolled back, so a third call waits only the
    // remaining ~800ms (to the 1000ms slot), not 1800ms (to a pushed-out 2000ms
    // slot). Advancing 800ms therefore resolves it; without the release it would
    // still be throttled here.
    const third = call();
    await vi.advanceTimersByTimeAsync(800);
    await expect(third).resolves.toEqual({ value: 'ok' });
    expect(doGenerate).toHaveBeenCalledTimes(2);
  });
});
