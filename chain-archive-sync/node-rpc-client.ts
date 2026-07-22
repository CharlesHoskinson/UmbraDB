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

export interface NodeRpcClientOptions {
  url: string;
  fetchImpl?: typeof fetch;
}

let nextId = 1;

/** Real, minimal Substrate JSON-RPC client -- one HTTP POST per call, no batching/subscriptions
 *  (a polling ingestion loop, §"reasonable ongoing-sync design," does not need either). */
export class NodeRpcClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: NodeRpcClientOptions) {
    this.url = opts.url;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const id = nextId++;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
    } catch (err) {
      throw new NodeRpcError(`${method}: request to ${this.url} failed`, err);
    }
    if (!res.ok) {
      throw new NodeRpcError(`${method}: HTTP ${res.status} from ${this.url}`);
    }
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
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
   *  direct "height of this hash" call, so this is the standard two-hop lookup. */
  async getHeightOf(blockHash: string): Promise<number> {
    const header = await this.getHeader(blockHash);
    return parseInt(header.number, 16);
  }
}
