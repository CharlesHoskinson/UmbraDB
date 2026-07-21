/**
 * Shared `AbortSignal` helpers for the Postgres adapter layer. Extracted from
 * `temporal-kv.ts` (where these originated during Sprint 1) so `transaction-lease.ts` can reuse
 * the exact same, already-audited logic rather than duplicate it — matching this project's own
 * precedent of centralizing a helper once a second real call site needs it (e.g. `errors.ts`'s
 * `isStatementTimeout`).
 */

/**
 * Always produces a real, correctly-named `AbortError` — regardless of what `signal.reason`
 * actually is. Only a `reason` that is ALREADY a correctly-named `AbortError`/`DOMException` is
 * passed through unchanged; anything else (a custom reason, or none) gets wrapped. Fixed during
 * Sprint 1 after a cross-vendor audit found the original version returned `signal.reason`
 * directly whenever it happened to be an `Error` instance, letting an arbitrary
 * `controller.abort(new Error("..."))` reason leak out instead of the `AbortError` this
 * interface's contract promises.
 */
export function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof DOMException && reason.name === "AbortError") return reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException("The operation was aborted", "AbortError");
}

/**
 * Runs `fn()` unless `signal` is already aborted, in which case it rejects with `AbortError`
 * WITHOUT ever calling `fn`. This is a pre-check-only contract: an abort that fires AFTER `fn()`
 * has been dispatched has no effect on that in-flight call. Fixed during Sprint 1 after a
 * cross-vendor audit found the original implementation raced an already-started promise against
 * the abort event (since the query was evaluated as a plain argument, it was always dispatched
 * regardless of whether the signal was already aborted, and there is no general way to cancel an
 * in-flight Postgres query from here without dedicated per-call cancellation machinery).
 * `listKeys` and lease acquisition build their OWN dedicated cancellation on top of real
 * `query.cancel()` where genuine mid-wait abort matters (a long-blocking call, unlike a quick
 * key-value read/write) — this helper is deliberately the simpler, narrower building block for
 * everything else.
 */
export function withAbort<T>(fn: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return fn();
}
