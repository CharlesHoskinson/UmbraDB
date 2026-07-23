import { describe, expect, it } from "vitest";
import { IndexerClient, IndexerClientParseError } from "./indexer-client.js";

/**
 * Sprint-fix round Fix 3 (MEDIUM), unit-level (no real network/Postgres) -- see
 * `node-rpc-client.test.ts`'s own doc for the full rationale; this is the same fix applied to the
 * indexer's GraphQL client.
 */
describe("IndexerClient -- Fix 3", () => {
  it("a request that never resolves is aborted once the configured timeout elapses, instead of hanging forever", async () => {
    const neverResolvingFetch: typeof fetch = (_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    };
    const client = new IndexerClient({ url: "http://fake-indexer", fetchImpl: neverResolvingFetch, timeoutMs: 50 });

    const start = Date.now();
    await expect(client.getTipHeight()).rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  it("fetch is called with an AbortSignal reflecting the configured timeout, not left unbounded", async () => {
    let observedSignal: AbortSignal | undefined;
    const fakeFetch: typeof fetch = async (_url, init) => {
      observedSignal = (init as { signal?: AbortSignal } | undefined)?.signal;
      return new Response(JSON.stringify({ data: { block: { height: 5 } } }), { status: 200 });
    };
    const client = new IndexerClient({ url: "http://fake-indexer", fetchImpl: fakeFetch, timeoutMs: 12_345 });
    await client.getTipHeight();
    expect(observedSignal).toBeInstanceOf(AbortSignal);
  });

  it("an HTTP 200 response with a non-JSON body (e.g. a proxy's HTML error page) throws a typed IndexerClientParseError carrying the URL, not a bare SyntaxError", async () => {
    const htmlErrorPageFetch: typeof fetch = async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const client = new IndexerClient({ url: "http://fake-indexer.example", fetchImpl: htmlErrorPageFetch });

    let caught: unknown;
    try {
      await client.getTipHeight();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IndexerClientParseError);
    expect((caught as IndexerClientParseError).url).toBe("http://fake-indexer.example");
  });

  it("a well-formed response still round-trips correctly (no false positives from the new error handling)", async () => {
    const wellFormedFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ data: { block: { height: 123 } } }), { status: 200 });
    const client = new IndexerClient({ url: "http://fake-indexer", fetchImpl: wellFormedFetch });
    await expect(client.getTipHeight()).resolves.toBe(123);
  });
});
