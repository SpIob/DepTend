/**
 * Direct unit tests for the shared transport policy (fetch-retry.ts).
 *
 * The wrapper is load-bearing for every outbound third-party call in this
 * directory, so its edge cases are pinned here rather than inferred
 * indirectly through osv/changelog-signals suites. All fetch behavior is
 * stubbed via vi.stubGlobal — no network.
 *
 * Timing discipline: tests pass `retryDelayMs: 0`; the Retry-After paths
 * that would otherwise really sleep use vi.useFakeTimers and advance
 * manually. Timeout tests use real timers with tiny deadlines —
 * AbortSignal.timeout timers don't keep the event loop alive, so they can't
 * leak past the test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_RETRY_DELAY_MS,
  MAX_RETRY_AFTER_MS,
  fetchWithRetry,
  parseRetryAfterMs,
} from "./fetch-retry.js";

const URL = "https://example.test/endpoint";

function jsonResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

function responseWithControllableBody(
  status: number,
  headers: Record<string, string> = {},
): { response: Response; cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn().mockResolvedValue(undefined);
  const response = jsonResponse(status, headers);
  // Shadow the real stream getter so we can observe the wrapper's
  // connection-hygiene call without constructing a live ReadableStream.
  Object.defineProperty(response, "body", { value: { cancel }, configurable: true });
  return { response, cancel };
}

describe("parseRetryAfterMs", () => {
  function resWithHeader(value: string): Response {
    return jsonResponse(429, { "retry-after": value });
  }

  it("returns -1 when the header is absent", () => {
    expect(parseRetryAfterMs(jsonResponse(500), 1_000)).toBe(-1);
  });

  it("converts seconds to milliseconds", () => {
    expect(parseRetryAfterMs(resWithHeader("3"), 1_000_000)).toBe(3_000);
  });

  it("clamps to maxMs", () => {
    expect(parseRetryAfterMs(resWithHeader("9999"), 5_000)).toBe(5_000);
    expect(
      parseRetryAfterMs(resWithHeader(String(MAX_RETRY_AFTER_MS / 1000 + 60)), MAX_RETRY_AFTER_MS),
    ).toBe(MAX_RETRY_AFTER_MS);
  });

  it("returns -1 for non-numeric (HTTP-date) values", () => {
    // GitHub/libraries.io use delta-seconds; the HTTP-date form parses as NaN
    // here and is treated as unusable rather than guessed at.
    expect(parseRetryAfterMs(resWithHeader("Wed, 21 Oct 2015 07:28:00 GMT"), 1_000)).toBe(-1);
  });

  it("returns -1 for negative values", () => {
    expect(parseRetryAfterMs(resWithHeader("-2"), 1_000)).toBe(-1);
  });
});

describe("fetchWithRetry", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("no-retry passthroughs", () => {
    it("returns an OK response untouched with a single call", async () => {
      const ok = jsonResponse(200);
      fetchMock.mockResolvedValue(ok);

      const result = await fetchWithRetry(URL, undefined, { retryDelayMs: 0 });

      expect(result).toBe(ok);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("passes a non-transient failure straight back without retrying", async () => {
      for (const status of [400, 403, 404, 409, 410, 422]) {
        fetchMock.mockClear();
        fetchMock.mockResolvedValue(jsonResponse(status));

        const result = await fetchWithRetry(URL, undefined, { retryDelayMs: 0 });

        expect(result.status).toBe(status);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
    });

    it("does not retry a plain 403 even though 403 can be transient elsewhere", async () => {
      // GitHub's secondary limits surface as 403 WITH Retry-After; a plain
      // 403 (actually forbidden) must not burn one more request.
      fetchMock.mockResolvedValue(jsonResponse(403));

      const result = await fetchWithRetry(URL, undefined, { retryDelayMs: 0 });

      expect(result.status).toBe(403);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("retryable responses", () => {
    it("retries each transient status once and returns the second attempt", async () => {
      for (const status of [429, 500, 502, 503, 504]) {
        fetchMock.mockClear();
        const recovered = jsonResponse(200);
        fetchMock.mockImplementation((_url: string | URL | Request) =>
          Promise.resolve(fetchMock.mock.calls.length === 1 ? jsonResponse(status) : recovered),
        );

        const result = await fetchWithRetry(URL, undefined, { retryDelayMs: 0 });

        expect(result).toBe(recovered);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      }
    });

    it("propagates the second transient failure instead of looping", async () => {
      const stillFailing = jsonResponse(503);
      fetchMock.mockResolvedValue(stillFailing);

      const result = await fetchWithRetry(URL, undefined, { retryDelayMs: 0 });

      expect(result).toBe(stillFailing);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries a non-retryable status when it carries a usable Retry-After", async () => {
      // The GitHub 403-with-Retry-After secondary-limit case.
      fetchMock
        .mockImplementationOnce(() => Promise.resolve(jsonResponse(403, { "retry-after": "0" })))
        .mockImplementationOnce(() => Promise.resolve(jsonResponse(200)));

      const result = await fetchWithRetry(URL, undefined, { retryDelayMs: 0 });

      expect(result.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("network errors", () => {
    it("retries once after a thrown fetch error and recovers", async () => {
      const ok = jsonResponse(200);
      fetchMock.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(ok);

      const result = await fetchWithRetry(URL, undefined, { retryDelayMs: 0 });

      expect(result).toBe(ok);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("propagates the second network failure", async () => {
      fetchMock.mockRejectedValue(new Error("ENOTFOUND"));

      await expect(fetchWithRetry(URL, undefined, { retryDelayMs: 0 })).rejects.toThrow(
        "ENOTFOUND",
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("backoff timing", () => {
    it("sleeps for the flat retryDelayMs when no Retry-After is present", async () => {
      vi.useFakeTimers();
      fetchMock
        .mockImplementationOnce(() => Promise.resolve(jsonResponse(500)))
        .mockImplementationOnce(() => Promise.resolve(jsonResponse(200)));

      const pending = fetchWithRetry(URL, undefined, { retryDelayMs: 7_500 });

      // Not yet retried before the backoff elapses:
      await vi.advanceTimersByTimeAsync(7_499);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toHaveProperty("status", 200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("waits the capped Retry-After duration instead of the flat delay", async () => {
      vi.useFakeTimers();
      fetchMock
        .mockImplementationOnce(() => Promise.resolve(jsonResponse(429, { "retry-after": "2" })))
        .mockImplementationOnce(() => Promise.resolve(jsonResponse(200)));

      const pending = fetchWithRetry(URL, undefined, { retryDelayMs: 0 });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toHaveProperty("status", 200);
    });
  });

  describe("body hygiene", () => {
    it("cancels the unread body of a transient failed attempt", async () => {
      const first = responseWithControllableBody(503);
      const second = responseWithControllableBody(200);
      fetchMock
        .mockImplementationOnce(() => Promise.resolve(first.response))
        .mockImplementationOnce(() => Promise.resolve(second.response));

      const result = await fetchWithRetry(URL, undefined, { retryDelayMs: 0 });

      expect(result).toBe(second.response);
      expect(first.cancel).toHaveBeenCalledTimes(1);
      expect(second.cancel).not.toHaveBeenCalled(); // final response stays readable
    });

    it("cancels the unread body of a Retry-After-carrying attempt", async () => {
      const first = responseWithControllableBody(403, { "retry-after": "0" });
      const second = jsonResponse(200);
      fetchMock
        .mockImplementationOnce(() => Promise.resolve(first.response))
        .mockImplementationOnce(() => Promise.resolve(second));

      const result = await fetchWithRetry(URL, undefined, { retryDelayMs: 0 });

      expect(result).toBe(second);
      expect(first.cancel).toHaveBeenCalled();
    });
  });

  describe("per-attempt deadline", () => {
    it.each([undefined, 0])(
      "is armed by default and disabled by timeoutMs=%s",
      async (timeoutMs) => {
        // Default policy arms the deadline; explicit 0 opts out. Either way a
        // healthy immediate response passes through with exactly one call.
        const ok = jsonResponse(200);
        fetchMock.mockResolvedValue(ok);

        const options =
          timeoutMs === undefined ? { retryDelayMs: 0 } : { retryDelayMs: 0, timeoutMs };

        const result = await fetchWithRetry(URL, undefined, options);

        expect(result).toBe(ok);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      },
    );

    it("arms every attempt with a fresh AbortSignal", async () => {
      fetchMock
        .mockImplementationOnce(() => Promise.resolve(jsonResponse(503)))
        .mockImplementationOnce(() => Promise.resolve(jsonResponse(200)));

      await fetchWithRetry(URL, undefined, { retryDelayMs: 0 });

      const [firstInit, secondInit] = fetchMock.mock.calls.map((call) => call[1] as RequestInit);
      expect(firstInit?.signal).toBeDefined();
      expect(secondInit?.signal).toBeDefined();
      expect(firstInit?.signal).not.toBe(secondInit?.signal);
    });

    it("surfaces a hung socket as a retryable failure and recovers", async () => {
      // First attempt hangs forever but honors the deadline we arm;
      // second succeeds immediately.
      let calls = 0;
      const stubFetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        calls += 1;
        if (calls === 1) {
          return new Promise((_resolve, reject) => {
            const signal = init?.signal ?? undefined;
            if (signal === undefined) return;
            signal.addEventListener("abort", () => {
              reject(new Error(`Attempt aborted (${String(signal.reason)})`));
            });
          });
        }
        return Promise.resolve(jsonResponse(200));
      };
      vi.stubGlobal("fetch", stubFetch);

      const result = await fetchWithRetry(URL, undefined, {
        retryDelayMs: 0,
        timeoutMs: 20,
      });

      expect(result.status).toBe(200);
      expect(calls).toBe(2);
    }, 5_000);

    it("rejects when both attempts hang past the deadline", async () => {
      fetchMock.mockImplementation(
        (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal ?? undefined;
            if (signal === undefined) return;
            signal.addEventListener("abort", () => {
              reject(new Error(`Attempt aborted (${String(signal.reason)})`));
            });
          }),
      );

      await expect(
        fetchWithRetry(URL, undefined, { retryDelayMs: 0, timeoutMs: 15 }),
      ).rejects.toThrow(/aborted/i);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }, 5_000);

    it("carries forward caller RequestInit fields onto each attempt", async () => {
      fetchMock
        .mockImplementationOnce(() => Promise.resolve(jsonResponse(500)))
        .mockImplementationOnce(() => Promise.resolve(jsonResponse(200)));

      await fetchWithRetry(
        URL,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        { retryDelayMs: 0 },
      );

      for (const [, init] of fetchMock.mock.calls) {
        const requestInit = init as RequestInit;
        expect(requestInit.method).toBe("POST");
        expect(requestInit.body).toBe("{}");
        expect(requestInit.headers).toHaveProperty("Content-Type");
      }
    });
  });

  describe("caller cancellation", () => {
    it("does not consume the single retry when the caller aborts mid-flight", async () => {
      const controller = new AbortController();
      fetchMock.mockImplementation(
        (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal ?? undefined;
            if (signal === undefined) return;
            signal.addEventListener("abort", () => {
              reject(new Error(`Attempt aborted (${String(signal.reason)})`));
            });
          }),
      );

      const pending = fetchWithRetry(
        URL,
        { signal: controller.signal },
        { retryDelayMs: 0, timeoutMs: 0 },
      );
      controller.abort();

      await expect(pending).rejects.toThrow(/aborted/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("still retries genuine network failures when only a caller signal is attached", async () => {
      const controller = new AbortController();
      const ok = jsonResponse(200);
      fetchMock.mockRejectedValueOnce(new Error("EAI_AGAIN")).mockResolvedValueOnce(ok);

      const result = await fetchWithRetry(
        URL,
        { signal: controller.signal },
        { retryDelayMs: 0, timeoutMs: 0 },
      );

      expect(result).toBe(ok);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(controller.signal.aborted).toBe(false);
    });
  });

  describe("defaults", () => {
    it("exposes the documented default backoff and deadline", () => {
      expect(DEFAULT_RETRY_DELAY_MS).toBe(30_000);
      expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(30_000);
      expect(MAX_RETRY_AFTER_MS).toBe(120_000);
    });
  });

  describe("maxRetryAfterMs", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("caps the honored Retry-After sleep at the caller's budget, not the server's", async () => {
      // A 403 with Retry-After: 120 — the unauthenticated GitHub budget's
      // signature. An interactive caller must not sleep two minutes inside
      // its own request just because the header says so (ADR 0037).
      fetchMock
        .mockImplementationOnce(() => Promise.resolve(jsonResponse(403, { "retry-after": "120" })))
        .mockImplementationOnce(() => Promise.resolve(jsonResponse(200)));

      const pending = fetchWithRetry(URL, undefined, {
        retryDelayMs: 30_000,
        maxRetryAfterMs: 2_000,
      });

      // The capped wait (2 s), not the server's (120 s), elapses before the
      // retry fires.
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(result.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keeps the full MAX_RETRY_AFTER_MS window when no budget is given", async () => {
      fetchMock
        .mockImplementationOnce(() => Promise.resolve(jsonResponse(429, { "retry-after": "60" })))
        .mockImplementationOnce(() => Promise.resolve(jsonResponse(200)));

      const pending = fetchWithRetry(URL, undefined, {});

      // Background ingestion's contract is unchanged: a 60 s Retry-After is
      // honored in full when the caller hasn't opted into a tighter cap.
      await vi.advanceTimersByTimeAsync(59_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(result.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
