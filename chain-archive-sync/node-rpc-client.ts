/**
 * Minimal Substrate JSON-RPC client for a Midnight node -- plain `fetch`, no SDK dependency
 * (`@midnightntwrk/*` is not imported anywhere in this file or this directory). Grounded against
 * the real local devnet node (`http://localhost:9944`, `midnightntwrk/midnight-node`) during this
 * implementation session -- `rpc_methods` confirmed `chain_getHeader`/`chain_getBlockHash`/
 * `chain_getBlock`/`chain_getFinalizedHead` are all live; `chain_getHeader`'s shape matches the
 * standard Substrate `generic::Header<BlockNumber,BlakeTwo256>` the design doc's §3.1 predicted
 * (`parentHash`, `number`, `stateRoot`, `extrinsicsRoot`, `digest.logs[]`); `chain_getBlock`
 * additionally returns `block.extrinsics: string[]` (0x-hex-encoded raw SCALE bytes per
 * extrinsic) and `block.header`.
 *
 * **Lives entirely outside `src/`** (AC-7) -- this is real, non-test production code that talks
 * directly to a node's RPC endpoint; `test/postgres/no-chain-sync-import-guard.test.ts` is the
 * automated guard confirming nothing under `src/` ever imports this module or references its
 * endpoint-talking behavior.
 */

export interface SubstrateHeader {
  parentHash: string;
  number: string; // 0x-hex compact block number
  stateRoot: string;
  extrinsicsRoot: string;
  digest: { logs: string[] };
}

export interface SubstrateBlock {
  block: {
    header: SubstrateHeader;
    extrinsics: string[];
  };
  justifications: unknown;
}

export class NodeRpcError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "NodeRpcError";
  }
}

/** Fix 3 (sprint-fix round, MEDIUM): a typed error for the specific "HTTP 200 but the body isn't
 *  valid JSON" case (e.g. a proxy/load-balancer's HTML error page returned with a 2xx status) --
 *  raised instead of letting `res.json()`'s bare, context-free `SyntaxError` propagate, which
 *  gave no indication of which request/URL/method failed. */
export class NodeRpcParseError extends Error {
  constructor(message: string, readonly url: string, readonly method: string, readonly cause?: unknown) {
    super(message);
    this.name = "NodeRpcParseError";
  }
}

/** Fix 3: raised by `getHeightOf` when the node's `header.number` field is missing or does not
 *  decode to a safe integer -- previously `parseInt(header.number, 16)` silently produced `NaN`
 *  in that case, which then made `syncOnce`'s loop-bounds check (`startHeight > NaN` is always
 *  `false`) silently no-op the entire sync attempt while still reporting success. */
export class NodeRpcInvalidHeightError extends Error {
  constructor(message: string, readonly blockHash: string | undefined, readonly rawNumber: unknown) {
    super(message);
    this.name = "NodeRpcInvalidHeightError";
  }
}

export interface NodeRpcClientOptions {
  url: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds -- a hung/black-holed node otherwise stalls the entire
   *  sync service indefinitely with no way to recover (Fix 3). Default: 20_000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

let nextId = 1;

/** Real, minimal Substrate JSON-RPC client -- one HTTP POST per call, no batching/subscriptions
 *  (a polling ingestion loop, §"reasonable ongoing-sync design," does not need either). */
export class NodeRpcClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: NodeRpcClientOptions) {
    this.url = opts.url;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const id = nextId++;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new NodeRpcError(`${method}: request to ${this.url} failed`, err);
    }
    if (!res.ok) {
      throw new NodeRpcError(`${method}: HTTP ${res.status} from ${this.url}`);
    }
    let body: { result?: T; error?: { code: number; message: string } };
    try {
      body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    } catch (err) {
      throw new NodeRpcParseError(
        `${method}: response body from ${this.url} was not valid JSON`, this.url, method, err,
      );
    }
    if (body.error !== undefined) {
      throw new NodeRpcError(`${method}: RPC error ${body.error.code}: ${body.error.message}`);
    }
    return body.result as T;
  }

  /** `null` params ⇒ current best (not-necessarily-finalized) head's hash. */
  async getBlockHash(height?: number): Promise<string> {
    return this.call<string>("chain_getBlockHash", height === undefined ? [] : [height]);
  }

  async getHeader(blockHash?: string): Promise<SubstrateHeader> {
    return this.call<SubstrateHeader>("chain_getHeader", blockHash === undefined ? [] : [blockHash]);
  }

  async getBlock(blockHash?: string): Promise<SubstrateBlock> {
    return this.call<SubstrateBlock>("chain_getBlock", blockHash === undefined ? [] : [blockHash]);
  }

  async getFinalizedHead(): Promise<string> {
    return this.call<string>("chain_getFinalizedHead", []);
  }

  /** Convenience: resolves a hash to its height via `getHeader` -- the RPC surface has no
   *  direct "height of this hash" call, so this is the standard two-hop lookup.
   *
   *  Fix 3 (sprint-fix round, MEDIUM): explicitly validates the decoded height is a safe integer
   *  before returning it -- a malformed/missing `header.number` previously produced a silent
   *  `NaN` here, which made `syncOnce`'s own `startHeight > targetTipHeight` bounds check
   *  (`startHeight > NaN` is always `false`) silently skip the entire sync attempt while
   *  `syncOnce` still returned a normal-looking success result. */
  async getHeightOf(blockHash: string): Promise<number> {
    const header = await this.getHeader(blockHash);
    const height = parseInt(header.number, 16);
    if (!Number.isSafeInteger(height)) {
      throw new NodeRpcInvalidHeightError(
        `chain_getHeader returned a malformed/missing "number" field for blockHash=${blockHash}: ` +
        `${JSON.stringify(header.number)} did not decode to a safe integer`,
        blockHash, header.number,
      );
    }
    return height;
  }
}
