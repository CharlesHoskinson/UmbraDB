# Research Assessment: Single-Statement Unbounded `bytea` Inserts via postgres.js

*Produced by an autonomous research council — 4 independent Sonnet-5 online-research angles (postgres.js binary capability, the COPY path, alternative-driver binary arrays, PostgreSQL protocol limits) consolidated by a Fable-5 lead, 2026-07. It studies whether a **known resolution** exists for the "exactly-one-statement-for-any-N" infeasibility recorded in `docs/v1-implementation-guideline.md` §2.2 and `AUTONOMOUS_RUN_LOG.md` R10 (the HP-1 checkpoint-chunk insert). Every claim below is source-verified against the postgres.js and PostgreSQL sources, not speculated.*

---

## 1. Is there a known resolution — bounded-constant statement count, unbounded rows, no bind-param cap, no V8 string limit?

**Yes — exactly one: `COPY … FROM STDIN (FORMAT binary)` into a temp table, then `INSERT … SELECT … ON CONFLICT`. A bounded constant of 3 statements (2 with a reused temp table). Every other angle is a verified dead end.**

| Angle | Result | Killing fact |
|---|---|---|
| postgres.js binary bind | **Dead end** | `Bind()` in `src/connection.js` hardcodes the format-code count `i16(0)` (all-text); every param goes through `.str()` → `buffer.write(x, …, 'utf8')`, which needs a JS string. No config surface. Binary-protocol request (Discussion #258) open since 2021. Installed 3.4.9 = latest — not an upgrade issue. |
| custom serializer / `sql.array` / server-side fn on `bytea[]` | **Dead end** | Serializers only produce *strings* for the text writer; `arraySerializer` concatenates hex-escaped elements into one giant JS string — that IS the V8 max-string failure. `unnest()`/plpgsql wrapping changes nothing client-side: encoding is chosen from the OID, blind to surrounding SQL. |
| `pg` (node-postgres), hand-packed binary `bytea[]` | **Works but NOT unbounded** | Scalar `Buffer` passthrough is real (format code 1, raw copy, since pg PR #447; pure-JS `pg` only). But an array of Buffers still routes through text `arrayString()`; a hand-packed binary array is one varlena → hard-capped at **1 GiB** by TOAST. ~8× ceiling, still bounded, + a second driver/pool/cross-driver-txn problem. Not worth it. |
| **COPY BINARY** | **Genuine escape** | `.writable()` uses the simple-query protocol: no Bind message is ever sent (the param cap is a property of Bind's int16 field — structurally absent); chunks are `Buffer`s wrapped in `CopyData` and written straight to the socket (no JS string is ever built — the V8 limit is structurally absent). Verified at `src/query.js:62-70`, `src/connection.js:857-866`. |

**Two factual corrections to fold into §2.2 regardless of the decision:**
- The protocol cap is **65535** (`PQ_QUERY_PARAM_MAX_LIMIT`, a u16), but it is postgres.js's **driver-side** check (`>= 65534` throws) that actually binds and is slightly tighter. Cite the driver check, not "the protocol."
- The V8 max-string figure is **Node-version-specific**. On Node 24 (`buffer.constants.MAX_STRING_LENGTH` = 536,870,888 ≈ 512 MiB), the effective raw-`bytea` payload ceiling per statement is ~230–250 MiB (hex doubling), not ~110–125 MiB. State it as Node-dependent.

**§2.2's core determination stands:** a single `INSERT`/`VALUES`/`unnest` statement over unbounded `bytea` rows is physically infeasible under postgres.js. COPY is not a counterexample — it is a structurally different wire path. **§2.2 should be *annotated*, not retracted.**

## 2. Best candidate — COPY-BINARY into temp + INSERT-SELECT-ON-CONFLICT

**3 fixed statements** (`CREATE TEMP TABLE … ON COMMIT DROP`, `COPY … FROM STDIN (FORMAT binary)`, `INSERT … SELECT … ON CONFLICT`), all O(1) in bind parameters at any N. Reusable-temp-table variant: 2.

```js
const SIGNATURE = Buffer.from('PGCOPY\n\xff\r\n\0', 'binary')
const HEADER = Buffer.concat([SIGNATURE, Buffer.alloc(4), Buffer.alloc(4)])
const TRAILER = Buffer.from([0xff, 0xff]) // int16 -1

function encodeRow(hash, data) {
  const head = Buffer.alloc(6); head.writeInt16BE(2, 0); head.writeInt32BE(hash.length, 2)
  const dlen = Buffer.alloc(4); dlen.writeInt32BE(data.length, 0)
  return Buffer.concat([head, hash, dlen, data]) // bytea binary repr = raw bytes, no escaping
}

async function saveChunks(sql, chunks) {
  return sql.begin(async sql => {                    // pins ONE connection + atomicity
    await sql`CREATE TEMP TABLE tmp_chunks (hash bytea, data bytea) ON COMMIT DROP`
    const copyIn = await sql`COPY tmp_chunks (hash, data) FROM STDIN (FORMAT binary)`.writable()
    await pipeline(
      Readable.from((function* () {
        yield HEADER
        for (const { hash, data } of chunks) yield encodeRow(hash, data)
        yield TRAILER
      })()),
      copyIn
    )
    await sql`
      INSERT INTO ckpt_chunks (hash, data, created_at)
      SELECT DISTINCT ON (hash) hash, data, now()
      FROM tmp_chunks ORDER BY hash
      ON CONFLICT (hash) DO UPDATE SET created_at = EXCLUDED.created_at`
  })
}
```

**Correctness — preserves both required semantics:**
- **`created_at` grace-window refresh + content dedup: yes.** `ON CONFLICT (hash) DO UPDATE SET created_at = EXCLUDED.created_at` is identical whether rows come from `VALUES` or `SELECT` — standard PG behavior, unchanged by COPY as staging.
- **One mandatory fix:** the temp table has no unique constraint, so an in-batch duplicate hash would raise `21000: ON CONFLICT DO UPDATE cannot affect row a second time`. `SELECT DISTINCT ON (hash)` collapses it. (Same risk class the current `VALUES` path already dedups by hash.)
- **Connection pinning is non-negotiable:** temp tables are session-scoped; without `sql.begin()` / `sql.reserve()` / `max:1`, COPY and the INSERT-SELECT can land on different pooled connections → "relation does not exist." `sql.begin()` also makes the save **atomic** — strictly *stronger* than today's sub-batch loop, where a mid-loop failure can leave earlier sub-batches committed.
- **Residual bounds:** the per-field 32-bit length word (~2 GiB/value) is irrelevant to row count; row count is genuinely unbounded.

**Honestly-flagged unverified point:** `.writable()` inside a `sql.begin()` callback was not executed end-to-end against a live DB in this research cycle. The API design/docs strongly imply it works; a smoke test is a hard precondition to adoption.

## 3. Recommendation for UmbraDB

**Keep the defensive sub-batch as the shipped v1.0.0 path. Record COPY-BINARY as the verified bounded-constant alternative in §2.2. Do not adopt now.**
- The sub-batch is **crash-free at every scale today** and is exactly one statement for every realistic checkpoint payload; sub-batching fires only in the already-labeled pathological regime. COPY solves a statement-count *aesthetic*, not a *failure* UmbraDB hits.
- COPY's costs are concrete: hand-rolled PGCOPY framing (new binary-encoding surface, silent-corruption risk if wrong), Node stream backpressure, temp-table `CREATE` privilege, an extra round trip, and the untested `.writable()`-in-transaction combination — new audit surface for zero fixed failures against a release-blocked, cold-audited v1.0.0.
- The `pg`-driver and postgres.js-fork routes are rejected (bounded 1 GiB / dual-driver cost / unsupported wire-layer fork).
- **One cheap tuning win to take now:** if the sub-batch chunker keys off row/param count, switch it (or confirm it already keys) to a cumulative *hex-serialized-byte budget* with safe margin under the runtime Node's `MAX_STRING_LENGTH` (~100 MiB conservative; ~200+ MiB on Node ≥ 22). This roughly doubles rows-per-statement with no architectural change.

**Revisit trigger:** adopt COPY if (a) checkpoint saves routinely exceed the single-statement byte budget (multi-statement saves become the norm, not the pathological case), or (b) per-save atomicity across sub-batches becomes a requirement. Both convert COPY's fixed costs into paid-for value.

## 4. Migration/rollout note (if/when adopted)
1. **Smoke test first:** `.writable()` inside `sql.begin()` against a live PG, including a mid-stream `destroy()` (→ `CopyFail` → clean rollback) and an in-batch duplicate-hash case.
2. **Encoder** as a small pure module with byte-exact golden-vector unit tests (empty/1-row/multi-MB) + a `COPY … TO STDOUT (FORMAT binary)` round-trip property test.
3. **Gate behind a flag** (`UMBRA_CHECKPOINT_COPY=1`), defaulting to the sub-batch; CI runs both against the same fixtures asserting identical final state incl. `created_at` refresh.
4. **Permissions check** in every target env: temp-schema `CREATE` for the app role.
5. **Backpressure:** use `stream/promises` `pipeline` exclusively — never raw `.write()` loops.
6. **Docs:** amend §2.2 — keep the "single INSERT infeasible" finding, add the COPY escape with the corrected figures (driver cap `<65534` vs protocol 65535; Node-dependent V8 ~512 MiB on Node 24; PG 1 GiB varlena cap on any single bind value).
7. **Remove the sub-batch only after** COPY survives ≥1 full checkpoint/restore soak; the sub-batch is the rollback path until then.

---

**Bottom line:** a clean bounded-constant resolution exists (COPY BINARY + INSERT-SELECT, 3 statements, both ceilings structurally absent) — but **no clean *single-statement* resolution exists**, §2.2's core determination is correct and stands with an annotation, and the defensive sub-batch remains the right shipped default for v1.0.0. Adopt COPY only on the stated triggers, per the rollout plan.
