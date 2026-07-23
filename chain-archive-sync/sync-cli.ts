/**
 * chain-archive-sync CLI -- runs {@link ChainArchiveSyncService} in a resumable loop against a
 * live Midnight node (JSON-RPC) + indexer (GraphQL), populating the `chain_archive` schema. This
 * is the production/ops entry point the feature previously lacked
 * (`docs/features/full-chain-storage.md` §4 noted "no CLI entry point or npm script").
 *
 * Resumable: each `syncOnce` advances a persisted watermark, so restarts continue where they left
 * off. Points at Midnight's hosted public Preprod endpoints by default; override for a local
 * (from-source) stack via NODE_URL / INDEXER_URL.
 *
 * Env:
 *   ARCHIVE_PG      Postgres connection string for the archive DB (REQUIRED)
 *   NET             network id / row scope (default "preprod")
 *   ARCHIVE_SCHEMA  schema name (default "chain_archive")
 *   NODE_URL        Substrate JSON-RPC endpoint (default hosted Preprod node)
 *   INDEXER_URL     indexer GraphQL endpoint (default hosted Preprod indexer v4)
 *   MAX_BLOCKS      blocks ingested per syncOnce call (default 200)
 *
 * Run:  ARCHIVE_PG=postgres://user:pass@host:5432/db npx tsx chain-archive-sync/sync-cli.ts
 */
import { createClient } from "../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "./bootstrap.js";
import { ChainArchiveSyncService } from "./sync-service.js";

const CONN = process.env.ARCHIVE_PG;
if (!CONN) {
  // eslint-disable-next-line no-console
  console.error("ARCHIVE_PG is required (a Postgres connection string for the archive DB).");
  process.exit(1);
}
const NET = process.env.NET ?? "preprod";
const SCHEMA = process.env.ARCHIVE_SCHEMA ?? "chain_archive";
const NODE_URL = process.env.NODE_URL ?? "https://rpc.preprod.midnight.network";
const INDEXER_URL = process.env.INDEXER_URL ?? "https://indexer.preprod.midnight.network/api/v4/graphql";
const MAX_BLOCKS = Number(process.env.MAX_BLOCKS ?? "200");

const sql = createClient({ connectionString: CONN, schema: SCHEMA });
await bootstrapChainArchiveSchema(sql, SCHEMA);
const service = new ChainArchiveSyncService({
  sql,
  net: NET,
  schema: SCHEMA,
  node: { url: NODE_URL, timeoutMs: 30_000 },
  indexer: { url: INDEXER_URL, timeoutMs: 30_000 },
});

let stop = false;
const requestStop = (): void => {
  stop = true;
};
process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

// eslint-disable-next-line no-console
console.log(`[archive-sync] START net=${NET} schema=${SCHEMA} node=${NODE_URL} indexer=${INDEXER_URL}`);
while (!stop) {
  try {
    const r = await service.syncOnce({ maxBlocks: MAX_BLOCKS });
    const height = await service.getSyncedHeight();
    // eslint-disable-next-line no-console
    console.log(
      `${new Date().toISOString()} synced_height=${height} ingested=${r.ingestedBlocks} tip=${r.targetTipHeight}`,
    );
    if (r.ingestedBlocks === 0) await new Promise((res) => setTimeout(res, 10_000));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`${new Date().toISOString()} error: ${(e as Error).message} (retry in 15s)`);
    await new Promise((res) => setTimeout(res, 15_000));
  }
}
// eslint-disable-next-line no-console
console.log("[archive-sync] stopping");
await sql.end({ timeout: 5 });
