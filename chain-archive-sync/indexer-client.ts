/**
 * Minimal Midnight indexer GraphQL client -- plain `fetch`, no SDK dependency. Grounded against
 * the real local devnet indexer (`http://localhost:8088/api/v3/graphql`) via live schema
 * introspection during this implementation session: `Block{hash height protocolVersion
 * timestamp author ledgerParameters parent transactions systemParameters}`,
 * `Transaction{id hash protocolVersion raw block contractActions unshieldedCreatedOutputs
 * unshieldedSpentOutputs zswapLedgerEvents dustLedgerEvents}`. Confirmed live, non-empty data on
 * this devnet: dust ledger events (`DustInitialUtxo`/`DustGenerationDtimeUpdate`), unshielded
 * created outputs, and a small number of zswap ledger events.
 *
 * **Lives entirely outside `src/`** (AC-7), same rationale as `node-rpc-client.ts`.
 */

export class IndexerClientError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "IndexerClientError";
  }
}

/** Fix 3 (sprint-fix round, MEDIUM): a typed error for the specific "HTTP 200 but the body isn't
 *  valid JSON" case (e.g. a proxy/load-balancer's HTML error page returned with a 2xx status) --
 *  raised instead of letting `res.json()`'s bare, context-free `SyntaxError` propagate, which
 *  gave no indication of which request/URL failed. */
export class IndexerClientParseError extends Error {
  constructor(message: string, readonly url: string, readonly cause?: unknown) {
    super(message);
    this.name = "IndexerClientParseError";
  }
}

export interface IndexerTransaction {
  hash: string;
  protocolVersion: number;
  raw: string; // 0x-free hex (indexer's HexEncoded scalar has no 0x prefix, confirmed live)
}

export interface IndexerBlock {
  hash: string;
  height: number;
  transactions: IndexerTransaction[];
  systemParameters: { dParameter: { numPermissionedCandidates: number; numRegisteredCandidates: number } };
}

export interface IndexerClientOptions {
  url: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds -- a hung/black-holed indexer otherwise stalls the
   *  entire sync service indefinitely with no way to recover (Fix 3). Default: 20_000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class IndexerClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: IndexerClientOptions) {
    this.url = opts.url;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new IndexerClientError(`GraphQL request to ${this.url} failed`, err);
    }
    if (!res.ok) {
      throw new IndexerClientError(`GraphQL HTTP ${res.status} from ${this.url}`);
    }
    let body: { data?: T; errors?: { message: string }[] };
    try {
      body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    } catch (err) {
      throw new IndexerClientParseError(`response body from ${this.url} was not valid JSON`, this.url, err);
    }
    if (body.errors !== undefined && body.errors.length > 0) {
      throw new IndexerClientError(`GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
    }
    return body.data as T;
  }

  /** The current (best) tip's height, per the indexer's own sync progress -- used as an upper
   *  bound so ingestion never races ahead of what the indexer has actually indexed (relevant
   *  only for the tx-metadata half of ingestion, which is sourced from the indexer; the node-RPC
   *  half is independent of indexer sync progress). */
  async getTipHeight(): Promise<number> {
    const data = await this.query<{ block: { height: number } | null }>("{ block { height } }");
    if (data.block === null) throw new IndexerClientError("indexer reports no blocks yet");
    return data.block.height;
  }

  async getBlockByHeight(height: number): Promise<IndexerBlock | undefined> {
    const data = await this.query<{ block: IndexerBlock | null }>(
      `query($height: Int!) {
        block(offset: { height: $height }) {
          hash height
          transactions { hash protocolVersion raw }
          systemParameters { dParameter { numPermissionedCandidates numRegisteredCandidates } }
        }
      }`,
      { height },
    );
    return data.block ?? undefined;
  }
}
