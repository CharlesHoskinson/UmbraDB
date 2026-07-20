# Superseded — see `Formal/STORAGE_ALGEBRA.md`

**This document is retired as of 2026-07-20 and must not be treated as authoritative.** It was
the first-draft algebraic specification of the storage layer, written before the project's
`Formal/` directory existed. A cross-vendor audit (Codex GPT-5.6 Sol) found the design this
document described mathematically self-contradictory (Law T4 was impossible given the original
same-key-multiple-writes-per-transaction rule this document's P1 assumed), and a follow-up
cross-document consistency review found this file, left unedited after that fix landed, was
still being cited by `design/design.md` and other documents as if it were current — actively
misleading, since it disagrees with the fix on the exact rule that changed:

- Its P1 still assumes multiple `put`s to one key can share a transaction (the abandoned model).
- Its Law T4 is still marked "ASPIRATIONAL," with no mention of the one-write-per-key-per-transaction
  rule or `TransactionKeyReuseError` that make T4 well-defined in the corrected design.
- Its Law C2 still describes `refs(m) = m.chunk_hashes`, an array-of-hashes column that
  `design/design.md` §3 replaced with the `ckpt_manifest_chunks` junction table (a GIN-vs-junction-
  table fix from the Performance research pass).
- Its P4 compares only `.value`, which `Formal/STORAGE_ALGEBRA.md`'s P4 found under-specified
  (two adjacent versions sharing a value would pass a broken test) and fixed to compare the full
  `VersionedEntry`.
- It still uses the retired "GUARANTEED"/"ASPIRATIONAL" status-label scheme, which
  `Formal/STORAGE_ALGEBRA.md`'s own revision note calls out as a "dishonest label" applied before
  any implementation existed.

**The current, authoritative algebraic specification is
[`Formal/STORAGE_ALGEBRA.md`](../Formal/STORAGE_ALGEBRA.md).** Every law/property number in that
document (T1–T5, C1–C2, W1, L1, P1–P10) supersedes the same-numbered item here — do not read this
file for their content; the numbering happens to align, but the substance does not always match
(see the specific disagreements listed above). This file is kept only so old links/citations
resolve to an explanation rather than a 404; it will be deleted once nothing still references it
by path.
