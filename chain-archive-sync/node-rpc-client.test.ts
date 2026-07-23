import { describe, expect, it } from "vitest";
import { NodeRpcClient, NodeRpcInvalidHeightError, NodeRpcParseError } from "./node-rpc-client.js";

/**
 * Sprint-fix round Fix 3 (MEDIUM), unit-level (no real network/Postgres): a hung/black-holed node
 * previously stalled `NodeRpcClient` indefinitely (no `AbortSignal`/timeout on its `fetch` call),
 * a non-JSON 200 response threw a bare context-free `SyntaxError`, and a malformed/missing
 * `header.number` silently produced `NaN` from `getHeightOf` with no error raised at all. These
 * tests exercise each failure path for real against a controllable fake `fetch`, not just
 * reasoning about the code.
 */
describe("NodeRpcClient -- Fix 3", () => {
  it("a request that never resolves is aborted once the configured timeout elapses, instead of hanging forever", async () => {
    const neverResolvingFetch: typeof fetch = (_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    };
    const client = new NodeRpcClient({ url: "http://fake-node", fetchImpl: neverResolvingFetch, timeoutMs: 50 });

    const start = Date.now();
    await expect(client.getFinalizedHead()).rejects.toThrow();
    const elapsed = Date.now() - start;
    // Generous upper bound (not tied tightly to the 50ms timeout) -- this asserts the call
    // actually resolves in bounded time, not that it hangs until the test's own overall timeout.
    expect(elapsed).toBeLessThan(5000);
  });

  it("fetch is called with an AbortSignal reflecting the configured timeout, not left unbounded", async () => {
    let observedSignal: AbortSignal | undefined;
    const fakeFetch: typeof fetch = async (_url, init) => {
      observedSignal = (init as { signal?: AbortSignal } | undefined)?.signal;
      return new Response(JSON.stringify({ result: "0xabc" }), { status: 200 });
    };
    const client = new NodeRpcClient({ url: "http://fake-node", fetchImpl: fakeFetch, timeoutMs: 12_345 });
    await client.getFinalizedHead();
    expect(observedSignal).toBeInstanceOf(AbortSignal);
  });

  it("an HTTP 200 response with a non-JSON body (e.g. a proxy's HTML error page) throws a typed NodeRpcParseError carrying the URL and method, not a bare SyntaxError", async () => {
    const htmlErrorPageFetch: typeof fetch = async () =>
      new Response("<html><body>502 Bad Gateway</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const client = new NodeRpcClient({ url: "http://fake-node.example", fetchImpl: htmlErrorPageFetch });

    let caught: unknown;
    try {
      await client.getFinalizedHead();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NodeRpcParseError);
    const parseErr = caught as NodeRpcParseError;
    expect(parseErr.url).toBe("http://fake-node.example");
    expect(parseErr.method).toBe("chain_getFinalizedHead");
  });

  it("getHeightOf throws a typed NodeRpcInvalidHeightError instead of silently returning NaN when header.number is malformed", async () => {
    const malformedHeaderFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ result: { parentHash: "0x00", number: "not-hex!", stateRoot: "0x00", extrinsicsRoot: "0x00", digest: { logs: [] } } }), { status: 200 });
    const client = new NodeRpcClient({ url: "http://fake-node", fetchImpl: malformedHeaderFetch });

    let caught: unknown;
    let result: number | undefined;
    try {
      result = await client.getHeightOf("0xdeadbeef");
    } catch (err) {
      caught = err;
    }
    expect(result).toBeUndefined();
    expect(caught).toBeInstanceOf(NodeRpcInvalidHeightError);
    expect(Number.isNaN((caught as NodeRpcInvalidHeightError).rawNumber as unknown as number)).toBe(false); // rawNumber holds the raw string, not NaN
    expect((caught as NodeRpcInvalidHeightError).rawNumber).toBe("not-hex!");
  });

  it("getHeightOf throws a typed NodeRpcInvalidHeightError instead of silently returning NaN when header.number is missing entirely", async () => {
    const missingNumberFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ result: { parentHash: "0x00", stateRoot: "0x00", extrinsicsRoot: "0x00", digest: { logs: [] } } }), { status: 200 });
    const client = new NodeRpcClient({ url: "http://fake-node", fetchImpl: missingNumberFetch });
    await expect(client.getHeightOf("0xdeadbeef")).rejects.toBeInstanceOf(NodeRpcInvalidHeightError);
  });

  it("getHeightOf still returns a real number for a well-formed response (no false positives from the new validation)", async () => {
    const wellFormedFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ result: { parentHash: "0x00", number: "0x2a", stateRoot: "0x00", extrinsicsRoot: "0x00", digest: { logs: [] } } }), { status: 200 });
    const client = new NodeRpcClient({ url: "http://fake-node", fetchImpl: wellFormedFetch });
    await expect(client.getHeightOf("0xdeadbeef")).resolves.toBe(42);
  });
});
