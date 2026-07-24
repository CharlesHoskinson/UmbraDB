import { createHash } from "node:crypto";
import type { ISql } from "postgres";
import { ValidationError } from "../interfaces/storage-errors.js";
import {
  assertValidCheckpointIds,
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
import type { TransactionHandle, TransactionLeaseLayer } from "../interfaces/transaction-lease.js";
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

/**
 * HP-1 insert batch size (`v1.0.0-perf-baseline/design.md` §1; `tasks.md` §1.1 the sanctioned
 * "record-the-limitation" path). design.md §1 prescribed an array-`unnest` form
 * (`INSERT … SELECT … FROM unnest($1::bytea[], …)`) for a strict 2 statements per save, but
 * postgres.js CANNOT bind a `bytea[]` array parameter — the driver renders such a bind as
 * SQLSTATE 42846 ("cannot cast type record/text[] to bytea[]") against real Postgres, established
 * empirically — so a sub-batched multi-row `VALUES` insert is the robust equivalent. It removes the
 * pre-HP-1 O(N) per-chunk round-trips while never exceeding PostgreSQL's 65,535 bind-parameter
 * protocol cap: the junction insert binds 3 params/row (cap hit at ≥21,846 rows) and the chunk
 * upsert 2 params/row (cap hit at ≥32,768 rows), so a 10,000-row batch is at most 30,000 params —
 * a comfortable margin under 65,535. Round-trips per insert are `ceil(N / INSERT_ROW_BATCH)`, i.e.
 * exactly 1 for any realistic checkpoint (N ≤ 10,000 unique chunks / junction positions).
 */
const INSERT_ROW_BATCH = 10_000; // 10000 × 3 = 30000 < 65535

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
  chunkSize?: number; label?: string; signal?: AbortSignal; tx?: TransactionHandle;
} {
  // `signal` and `tx` are live handles intersected onto SaveCheckpointOptions, not data fields in
  // SaveCheckpointOptionsSchema (which stays byte-unchanged) -- strip both before safeParse and
  // thread them back through, exactly as `signal` was already handled.
  const { signal, tx, ...rest } = opts ?? {};
  const parsed = SaveCheckpointOptionsSchema.safeParse(rest);
  if (!parsed.success) throw ValidationError.fromZod("PgCheckpointStore.save opts", parsed.error);
  return { ...parsed.data, signal, tx };
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
 * `save` accepts an optional `opts.tx` transaction handle: when supplied it issues every statement
 * on the caller's transaction (resolved via `resolveTransaction`) and opens no `withTransaction`
 * of its own, so the checkpoint co-commits with whatever else the caller wrote (e.g. a watermark
 * advance via `saveAndAdvance`); when absent it composes `TransactionLeaseLayer.withTransaction`
 * internally exactly as before. `prune` deliberately still does NOT accept a `tx` option — it, and
 * `load`/`history`, compose `withTransaction` internally for every call, using `resolveTransaction`
 * to get the real transaction-scoped `sql` (`design.md` §8). `load`/`history` also run inside their
 * own `withTransaction` call, at
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
    assertValidCheckpointIds(walletId, networkId);
    const validated = validateSaveOptions(opts);
    return withAbort(() => this.saveImpl(walletId, networkId, data, validated), validated.signal);
  }

  private async saveImpl(
    walletId: string, networkId: string, data: Uint8Array,
    opts: { chunkSize?: number; label?: string; tx?: TransactionHandle },
  ): Promise<CheckpointSummary> {
    const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunks = splitChunks(data, chunkSize);
    const chunkHashes = chunks.map(sha256);
    const manifestHash = sha256(Buffer.concat(chunkHashes));

    // The write path, parameterised over which transaction-scoped `sql` it runs on -- byte-for-
    // byte the statements this method has always issued (chunk upsert -> seq alloc -> manifest
    // insert -> junction inserts). Both branches below run exactly this; only the transaction it
    // executes in differs.
    const runOnTx = async (sql: ISql<{ bigint: bigint }>): Promise<CheckpointSummary> => {
        // Dedup upsert (design/design.md §3, unchanged): the ON CONFLICT ... DO UPDATE refresh
        // of created_at is load-bearing for prune's grace-window TOCTOU safety (design.md §3),
        // not just a convenience -- a plain DO NOTHING would defeat the grace window on every
        // re-referenced-but-already-existing chunk.
        // HP-1 (v1.0.0-perf-baseline design.md §1; tasks.md §1.1): a BATCHED, EMPTY-SAFE multi-row
        // upsert instead of the pre-HP-1 per-chunk loop of single-row awaits (2N round-trips ->
        // ceil(N/INSERT_ROW_BATCH), i.e. 1 for any realistic checkpoint). See INSERT_ROW_BATCH for
        // why sub-batched `VALUES` -- not design §1's `unnest($1::bytea[], …)` -- is the robust
        // equivalent (postgres.js cannot bind a `bytea[]` array parameter, SQLSTATE 42846) and why
        // 10,000 rows stays under the 65,535 bind-param cap. postgres.js's sql(rows, ...cols) helper
        // maps each Buffer to bytea; the `ON CONFLICT ... DO UPDATE SET created_at = now()` refresh
        // is carried verbatim (load-bearing for prune's grace-window TOCTOU safety, unchanged).
        // Content-addressed: a repeated chunk yields a duplicate hash, and a single multi-row
        // upsert cannot touch the same ON CONFLICT target twice (Postgres SQLSTATE 21000), so
        // dedupe by hash for the chunk write. The junction insert below still records EVERY
        // position, repeats included, so a chunk reused at two positions stays representable.
        const seenChunkHashes = new Set<string>();
        const chunkRows: { hash: Buffer; data: Uint8Array }[] = [];
        for (let i = 0; i < chunks.length; i++) {
          const key = chunkHashes[i]!.toString("hex");
          if (seenChunkHashes.has(key)) continue;
          seenChunkHashes.add(key);
          chunkRows.push({ hash: chunkHashes[i]!, data: chunks[i]! });
        }
        // Empty-safe: chunkRows.length === 0 (a 0-chunk save of empty data) yields ZERO iterations
        // and issues NO statement, so an empty save persists as a 0-chunk manifest that round-trips
        // to empty -- the pre-HP-1 per-chunk loop's behaviour, and it also avoids postgres.js
        // rendering an invalid empty `VALUES` clause for `sql([], …)`.
        for (let i = 0; i < chunkRows.length; i += INSERT_ROW_BATCH) {
          const batch = chunkRows.slice(i, i + INSERT_ROW_BATCH);
          await sql`
            INSERT INTO ${sql(this.schema)}.ckpt_chunks ${sql(batch, "hash", "data")}
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
        // HP-1: a BATCHED, EMPTY-SAFE multi-row junction insert; position is preserved by the
        // input-array index. EVERY position is recorded (repeats included), unlike the by-hash
        // dedup of the chunk write above -- so a chunk reused at two positions stays representable.
        const junctionRows = chunkHashes.map((chunk_hash, i) => ({
          manifest_id: manifest.id,
          position: i,
          chunk_hash,
        }));
        // Empty-safe (0 chunks -> 0 iterations -> no statement, no invalid empty `VALUES`) and
        // batched so the 3-params/row junction insert never exceeds the 65,535 bind-param cap
        // (a single statement would otherwise throw at >= 21,846 junction rows, reachable by a
        // large payload at a small chunkSize). Round-trips = ceil(N / INSERT_ROW_BATCH).
        for (let i = 0; i < junctionRows.length; i += INSERT_ROW_BATCH) {
          const batch = junctionRows.slice(i, i + INSERT_ROW_BATCH);
          await sql`
            INSERT INTO ${sql(this.schema)}.ckpt_manifest_chunks ${sql(batch, "manifest_id", "position", "chunk_hash")}
          `;
        }

        return toSummary(manifest, data.byteLength, chunks.length);
    };

    // opts.tx: join the caller's transaction. Resolve the handle OUTSIDE the translate-try so a
    // stale/fabricated handle throws TransactionHandleInvalidError before any statement issues
    // (A5) -- the same ordering PgWatermarks.set uses. The caller's withTransaction owns
    // BEGIN/COMMIT; this issues none, so the checkpoint commits or rolls back with the caller's
    // transaction (e.g. co-committed with a watermark advance by saveAndAdvance). Query rejections
    // are translated to the frozen typed error classes here, never allowed to escape raw (C4).
    if (opts.tx !== undefined) {
      const sql = resolveTransaction(opts.tx);
      try {
        return await runOnTx(sql);
      } catch (err) {
        throw translatePostgresError(err);
      }
    }

    // Default path (no tx): byte-for-byte the prior behaviour -- own internal transaction, then
    // the same local error translation.
    try {
      return await this.txLayer.withTransaction((tx) => runOnTx(resolveTransaction(tx)));
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async load(
    walletId: string, networkId: string, sequence?: CheckpointSequence,
    opts?: { signal?: AbortSignal },
  ): Promise<CheckpointRecord> {
    assertValidCheckpointIds(walletId, networkId);
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
    assertValidCheckpointIds(walletId, networkId);
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

          // HP-2 + IS-2 (v1.0.0-perf-baseline design.md §2): one grouped query over the stored
          // size_bytes column instead of a per-manifest aggregate (1+N -> 2 round-trips); summing
          // ckpt_chunks.size_bytes (a generated column) never detoasts the `data` bytea. Rows are
          // re-associated to each manifest by manifest_id, preserving the ORDER BY seq DESC page order.
          const manifestIds = manifestRows.map((m) => m.id);
          const aggRows =
            manifestIds.length === 0
              ? []
              : await sql<(AggregateRow & { manifest_id: bigint })[]>`
                  SELECT mc.manifest_id,
                         count(*) AS chunk_count,
                         coalesce(sum(c.size_bytes), 0) AS byte_length
                  FROM ${sql(this.schema)}.ckpt_manifest_chunks mc
                  JOIN ${sql(this.schema)}.ckpt_chunks c ON c.hash = mc.chunk_hash
                  WHERE mc.manifest_id = ANY(${sql.array(manifestIds)})
                  GROUP BY mc.manifest_id
                `;
          const aggById = new Map(aggRows.map((a) => [a.manifest_id, a]));
          // A manifest with zero chunks yields no group row; fall back to (0, 0) exactly as the
          // former per-manifest scalar aggregate's coalesce did.
          const summaries: CheckpointSummary[] = manifestRows.map((manifest) => {
            const agg = aggById.get(manifest.id);
            return toSummary(
              manifest,
              coerceToSafeNumber(agg?.byte_length ?? 0n, "CheckpointSummary.byteLength"),
              coerceToSafeNumber(agg?.chunk_count ?? 0n, "CheckpointSummary.chunkCount"),
            );
          });
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
    assertValidCheckpointIds(walletId, networkId);
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
