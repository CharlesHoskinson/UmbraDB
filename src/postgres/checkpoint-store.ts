import { createHash } from "node:crypto";
import { ValidationError } from "../interfaces/storage-errors.js";
import {
  CheckpointNotFoundError,
  ChunkIntegrityError,
  ChunkMissingError,
  HistoryOptionsSchema,
  ManifestCorruptError,
  SaveCheckpointOptionsSchema,
  type CheckpointRecord,
  type CheckpointSequence,
  type CheckpointStore,
  type CheckpointSummary,
  type ContentHash,
  type HistoryOptions,
  type PruneResult,
  type SaveCheckpointOptions,
} from "../interfaces/checkpoint-store.js";
import type { TransactionLeaseLayer } from "../interfaces/transaction-lease.js";
import { withAbort } from "./abort.js";
import type { UmbraDBSql } from "./client.js";
import { translatePostgresError } from "./errors.js";
import { resolveTransaction } from "./transaction-lease.js";

/**
 * A Sprint-3 implementation decision, not derived from any prior document
 * (`openspec/changes/sprint-3-checkpoint-store/design.md` §1) — 4 MiB, a conservative middle
 * point between per-chunk row overhead and re-hash/re-store cost on a single-byte change.
 * Revisit under Milestone 4 once real checkpoint-size measurements exist.
 */
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

function sha256(data: Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

function toHex(buf: Buffer): ContentHash {
  return buf.toString("hex");
}

/** `design.md` §2.2's boundary coercion — every `bigint` the driver returns for a `seq`/count
 *  column is coerced to `number` before it reaches any interface-typed value; nothing downstream
 *  of this function handles `bigint`. */
function coerceToSafeNumber(value: bigint, context: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${context}: ${value} is outside the safe integer range`);
  }
  return Number(value);
}

interface ManifestRow {
  id: bigint;
  seq: bigint;
  created_at: Date;
  manifest_hash: Buffer;
  label: string | null;
}

interface ChunkJoinRow {
  position: number;
  chunk_hash: Buffer;
  hash: Buffer | null;
  data: Buffer | null;
}

interface AggregateRow {
  chunk_count: bigint;
  byte_length: bigint;
}

function splitChunks(data: Uint8Array, chunkSize: number): Buffer[] {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buf.byteLength; offset += chunkSize) {
    chunks.push(buf.subarray(offset, Math.min(offset + chunkSize, buf.byteLength)));
  }
  return chunks;
}

function validateSaveOptions(opts: SaveCheckpointOptions | undefined): {
  chunkSize?: number; label?: string; signal?: AbortSignal;
} {
  const { signal, ...rest } = opts ?? {};
  const parsed = SaveCheckpointOptionsSchema.safeParse(rest);
  if (!parsed.success) throw ValidationError.fromZod("PgCheckpointStore.save opts", parsed.error);
  return { ...parsed.data, signal };
}

function validateHistoryOptions(opts: HistoryOptions | undefined): {
  limit: number; before?: number; signal?: AbortSignal;
} {
  const { signal, ...rest } = opts ?? {};
  const parsed = HistoryOptionsSchema.safeParse(rest);
  if (!parsed.success) throw ValidationError.fromZod("PgCheckpointStore.history opts", parsed.error);
  return { ...parsed.data, signal };
}

function toSummary(row: ManifestRow, byteLength: number, chunkCount: number): CheckpointSummary {
  return {
    sequence: coerceToSafeNumber(row.seq, "CheckpointSummary.sequence"),
    manifestHash: toHex(row.manifest_hash),
    byteLength,
    chunkCount,
    ...(row.label !== null ? { label: row.label } : {}),
    createdAt: row.created_at,
  };
}

/**
 * Postgres implementation of `CheckpointStore` (`src/interfaces/checkpoint-store.ts`) against
 * the schema in `migrations/002_checkpoint_store.ts`
 * (`openspec/changes/sprint-3-checkpoint-store/design.md` §2/§6). Does not run migrations itself
 * — call `runMigrations` (`migrate.ts`) before constructing this against a fresh database.
 *
 * `save`/`prune` deliberately do NOT accept a `tx` option (`src/interfaces/checkpoint-store.ts`'s
 * own interface doc) — this adapter composes `TransactionLeaseLayer.withTransaction` internally
 * for every method, using `resolveTransaction` to get the real transaction-scoped `sql`
 * (`design.md` §8). `load`/`history` also run inside their own `withTransaction` call, at
 * REPEATABLE READ, so their multi-statement reads observe one consistent snapshot immune to a
 * concurrently-committing `prune` (`design.md` §4/§5/§8's torn-read fix).
 *
 * The `schema` constructor parameter defaults to `sql.umbradbSchema`, matching `PgTemporalKV`'s
 * own established pattern (`temporal-kv.ts`) — not an independent literal default.
 */
export class PgCheckpointStore implements CheckpointStore {
  constructor(
    private readonly sql: UmbraDBSql,
    private readonly txLayer: TransactionLeaseLayer,
    private readonly schema: string = sql.umbradbSchema,
  ) {}

  async save(
    walletId: string, networkId: string, data: Uint8Array, opts?: SaveCheckpointOptions,
  ): Promise<CheckpointSummary> {
    const validated = validateSaveOptions(opts);
    return withAbort(() => this.saveImpl(walletId, networkId, data, validated), validated.signal);
  }

  private async saveImpl(
    walletId: string, networkId: string, data: Uint8Array,
    opts: { chunkSize?: number; label?: string },
  ): Promise<CheckpointSummary> {
    const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunks = splitChunks(data, chunkSize);
    const chunkHashes = chunks.map(sha256);
    const manifestHash = sha256(Buffer.concat(chunkHashes));

    try {
      return await this.txLayer.withTransaction(async (tx) => {
        const sql = resolveTransaction(tx);

        // Dedup upsert (design/design.md §3, unchanged): the ON CONFLICT ... DO UPDATE refresh
        // of created_at is load-bearing for prune's grace-window TOCTOU safety (design.md §3),
        // not just a convenience -- a plain DO NOTHING would defeat the grace window on every
        // re-referenced-but-already-existing chunk.
        for (let i = 0; i < chunks.length; i++) {
          await sql`
            INSERT INTO ${sql(this.schema)}.ckpt_chunks (hash, data)
            VALUES (${chunkHashes[i]!}, ${chunks[i]!})
            ON CONFLICT (hash) DO UPDATE SET created_at = now()
          `;
        }

        // Sequence allocation (design.md §2.2): atomic upsert-increment, gapless and monotonic
        // under concurrency by construction (the row lock is held for this whole transaction).
        const seqRows = await sql<{ claimed_seq: bigint }[]>`
          INSERT INTO ${sql(this.schema)}.ckpt_sequence_counters (w, net)
          VALUES (${walletId}, ${networkId})
          ON CONFLICT (w, net) DO UPDATE
          SET next_seq = ${sql(this.schema)}.ckpt_sequence_counters.next_seq + 1
          RETURNING next_seq - 1 AS claimed_seq
        `;
        const seq = seqRows[0]!.claimed_seq;

        // complete = true is written EXPLICITLY, never left to the schema's DEFAULT false
        // (design.md §2.3 -- omitting this column here would make every subsequent load/
        // history/prune filter on complete see zero rows, a total silent failure).
        const manifestRows = await sql<ManifestRow[]>`
          INSERT INTO ${sql(this.schema)}.ckpt_manifests (w, net, seq, complete, manifest_hash, label)
          VALUES (
            ${walletId}, ${networkId}, ${seq}, true, ${manifestHash},
            ${opts.label ?? null}
          )
          RETURNING id, seq, created_at, manifest_hash, label
        `;
        const manifest = manifestRows[0]!;

        // Junction rows keyed by (manifest_id, position) -- design.md §2.1's fix -- so a
        // repeated chunk hash at two different positions is representable.
        for (let i = 0; i < chunkHashes.length; i++) {
          await sql`
            INSERT INTO ${sql(this.schema)}.ckpt_manifest_chunks (manifest_id, position, chunk_hash)
            VALUES (${manifest.id}, ${i}, ${chunkHashes[i]!})
          `;
        }

        return toSummary(manifest, data.byteLength, chunks.length);
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async load(
    walletId: string, networkId: string, sequence?: CheckpointSequence,
    opts?: { signal?: AbortSignal },
  ): Promise<CheckpointRecord> {
    return withAbort(() => this.loadImpl(walletId, networkId, sequence), opts?.signal);
  }

  private async loadImpl(
    walletId: string, networkId: string, sequence: CheckpointSequence | undefined,
  ): Promise<CheckpointRecord> {
    try {
      // REPEATABLE READ (design.md §4/§8): both statements below observe one consistent
      // snapshot, immune to a concurrently-committing prune's cascade removing junction rows
      // between them.
      return await this.txLayer.withTransaction(
        async (tx) => {
          const sql = resolveTransaction(tx);

          const manifestRows = await sql<ManifestRow[]>`
            SELECT id, seq, created_at, manifest_hash, label
            FROM ${sql(this.schema)}.ckpt_manifests
            WHERE w = ${walletId} AND net = ${networkId} AND complete
              AND (${sequence ?? null}::bigint IS NULL OR seq = ${sequence ?? null})
            ORDER BY seq DESC LIMIT 1
          `;
          if (manifestRows.length === 0) {
            throw new CheckpointNotFoundError(walletId, networkId, sequence);
          }
          const manifest = manifestRows[0]!;

          const chunkRows = await sql<ChunkJoinRow[]>`
            SELECT mc.position, mc.chunk_hash, c.hash, c.data
            FROM ${sql(this.schema)}.ckpt_manifest_chunks mc
            LEFT JOIN ${sql(this.schema)}.ckpt_chunks c ON c.hash = mc.chunk_hash
            WHERE mc.manifest_id = ${manifest.id}
            ORDER BY mc.position
          `;

          const parts: Buffer[] = [];
          const chunkHashesInOrder: Buffer[] = [];
          for (let i = 0; i < chunkRows.length; i++) {
            const row = chunkRows[i]!;
            // Dense 0..n-1 check (design.md §4): structurally impossible on any save() path,
            // a defense-in-depth assertion against out-of-band corruption.
            if (row.position !== i) {
              throw new ManifestCorruptError(
                toHex(manifest.manifest_hash),
                `position gap: expected ${i}, got ${row.position}`,
              );
            }
            // c.hash is NULL exactly when the LEFT JOIN found no ckpt_chunks row at all --
            // mc.chunk_hash (the manifest's own recorded hash) is the only place the missing
            // chunk's identity exists in that case.
            if (row.hash === null) {
              throw new ChunkMissingError(toHex(row.chunk_hash));
            }
            const actualHash = sha256(row.data!);
            if (!actualHash.equals(row.chunk_hash)) {
              throw new ChunkIntegrityError(toHex(actualHash), toHex(row.chunk_hash));
            }
            parts.push(row.data!);
            chunkHashesInOrder.push(row.chunk_hash);
          }

          // manifest_hash verification (design.md §4): catches a junction-row substitution that
          // the per-chunk integrity check and the position-density check cannot catch between
          // them (every referenced chunk individually valid, positions dense, but the chunk-hash
          // SEQUENCE as a whole no longer matches what save() actually wrote).
          const recomputedManifestHash = sha256(Buffer.concat(chunkHashesInOrder));
          if (!recomputedManifestHash.equals(manifest.manifest_hash)) {
            throw new ManifestCorruptError(
              toHex(manifest.manifest_hash),
              "recomputed manifest hash does not match the stored value",
            );
          }

          const data = Buffer.concat(parts);
          return {
            ...toSummary(manifest, data.byteLength, chunkRows.length),
            data,
          };
        },
        { isolation: "repeatable read" },
      );
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async history(
    walletId: string, networkId: string, opts?: HistoryOptions,
  ): Promise<CheckpointSummary[]> {
    const validated = validateHistoryOptions(opts);
    return withAbort(() => this.historyImpl(walletId, networkId, validated), validated.signal);
  }

  private async historyImpl(
    walletId: string, networkId: string, opts: { limit: number; before?: number },
  ): Promise<CheckpointSummary[]> {
    try {
      // Same torn-read fix as load (design.md §5/§8): the page query and each page entry's
      // aggregate query run inside one REPEATABLE READ transaction, so a prune committing
      // between them cannot make a returned summary reflect a different instant than the page
      // listing it.
      return await this.txLayer.withTransaction(
        async (tx) => {
          const sql = resolveTransaction(tx);

          const manifestRows = await sql<ManifestRow[]>`
            SELECT id, seq, created_at, manifest_hash, label
            FROM ${sql(this.schema)}.ckpt_manifests
            WHERE w = ${walletId} AND net = ${networkId} AND complete
              AND (${opts.before ?? null}::bigint IS NULL OR seq < ${opts.before ?? null})
            ORDER BY seq DESC
            LIMIT ${opts.limit}
          `;

          const summaries: CheckpointSummary[] = [];
          for (const manifest of manifestRows) {
            const aggRows = await sql<AggregateRow[]>`
              SELECT count(*) AS chunk_count, coalesce(sum(octet_length(c.data)), 0) AS byte_length
              FROM ${sql(this.schema)}.ckpt_manifest_chunks mc
              JOIN ${sql(this.schema)}.ckpt_chunks c ON c.hash = mc.chunk_hash
              WHERE mc.manifest_id = ${manifest.id}
            `;
            const agg = aggRows[0]!;
            summaries.push(toSummary(
              manifest,
              coerceToSafeNumber(agg.byte_length, "CheckpointSummary.byteLength"),
              coerceToSafeNumber(agg.chunk_count, "CheckpointSummary.chunkCount"),
            ));
          }
          return summaries;
        },
        { isolation: "repeatable read" },
      );
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async prune(
    walletId: string, networkId: string, retainCount: number,
    opts?: { signal?: AbortSignal },
  ): Promise<PruneResult> {
    // design.md §3: tightened to a safe-integer guard -- Number.isInteger(retainCount) alone
    // would admit magnitudes like 1e20 that are still meaningless as an OFFSET bound.
    if (!Number.isSafeInteger(retainCount) || retainCount < 1) {
      throw new ValidationError(
        "prune retainCount must be a safe integer >= 1",
        [{ path: "retainCount", message: `received ${String(retainCount)}` }],
      );
    }
    return withAbort(() => this.pruneImpl(walletId, networkId, retainCount), opts?.signal);
  }

  private async pruneImpl(
    walletId: string, networkId: string, retainCount: number,
  ): Promise<PruneResult> {
    try {
      // No isolation override -- READ COMMITTED, Postgres's default via withTransaction, is a
      // stated dependency (design.md §3): the grace-window TOCTOU argument relies on READ
      // COMMITTED's per-row re-evaluation semantics.
      return await this.txLayer.withTransaction(async (tx) => {
        const sql = resolveTransaction(tx);

        // Step 1: prune old superseded manifests. Deleting a manifest CASCADEs its
        // ckpt_manifest_chunks rows in the same statement (design.md §2.1's ON DELETE CASCADE),
        // making them invisible to step 2's NOT EXISTS check in the same pass.
        const prunedRows = await sql<{ seq: bigint }[]>`
          DELETE FROM ${sql(this.schema)}.ckpt_manifests m
          WHERE m.w = ${walletId} AND m.net = ${networkId} AND m.complete
            AND m.seq < (
              SELECT seq FROM ${sql(this.schema)}.ckpt_manifests
              WHERE w = ${walletId} AND net = ${networkId} AND complete
              ORDER BY seq DESC OFFSET ${retainCount - 1} LIMIT 1
            )
          RETURNING seq
        `;

        // Step 2: reclaim chunks no longer referenced by any surviving manifest, past the grace
        // window. Global, not scoped to (walletId, networkId) -- chunk storage is a single
        // cross-wallet pool (design/design.md §3).
        // The grace window ("15 minutes") is a hardcoded, trusted literal, never caller input --
        // inlined directly rather than bound as a parameter, matching design/design.md §3's own
        // SQL exactly (Postgres's interval-literal grammar wants a literal here, not a bind
        // parameter).
        // octet_length(c.data) is a bare (non-SUM) call -- Postgres returns plain `integer`
        // (OID 23) for it, which postgres.js's standard `number` type mapping parses directly to
        // a JS `number`, NOT `bigint` (the project's `types.bigint` override only remaps OID 20).
        // Confirmed empirically (a real "Cannot mix BigInt and other types" TypeError against
        // real Postgres, not an assumption) -- unlike `sum(octet_length(...))` in history's
        // aggregate query (§5), which DOES return `bigint` per SQL's sum(int4) -> int8 rule.
        const reclaimedRows = await sql<{ reclaimed_bytes: number }[]>`
          DELETE FROM ${sql(this.schema)}.ckpt_chunks c
          WHERE c.created_at < now() - interval '15 minutes'
            AND NOT EXISTS (
              SELECT 1 FROM ${sql(this.schema)}.ckpt_manifest_chunks mc WHERE mc.chunk_hash = c.hash
            )
          RETURNING octet_length(c.data) AS reclaimed_bytes
        `;

        const reclaimedBytes = reclaimedRows.reduce((sum, r) => sum + r.reclaimed_bytes, 0);

        return {
          prunedSequences: prunedRows.map((r) => coerceToSafeNumber(r.seq, "PruneResult.prunedSequences")),
          reclaimedChunks: reclaimedRows.length,
          reclaimedBytes,
        };
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }
}
