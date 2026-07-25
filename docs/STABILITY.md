# UmbraDB Stability Policy (SemVer)

UmbraDB follows [Semantic Versioning 2.0.0](https://semver.org/). This document is the binding
stability contract for the **frozen 1.0.0 public surface** — the single package-root barrel
(`import { ... } from "umbradb"`; see [`CHANGELOG.md`](../CHANGELOG.md) for the enumerated surface)
and the machine-facing error-`code` set ([`docs/ERROR-CATALOG.md`](ERROR-CATALOG.md)).

"The exported surface" means every value and type re-exported from the package root barrel
(`src/index.ts` → `dist/index.js` + `dist/index.d.ts`), reachable only through the strict
`exports` map's single `"."` entry. Internal modules (anything not re-exported from that barrel —
Zod schemas, `translatePostgresError` and the other adapter plumbing, the `AbortSignal` helpers,
and the deferred full-chain-archival track) are **not** part of the frozen surface and carry no
stability guarantee; deep imports of them are unresolvable for a consumer of the published package,
which is the enforcement mechanism, not a side effect.

## The three commitments

1. **No breaking changes to the exported surface or the error-`code` set in a minor or patch
   release.** Within the `1.x` line, the set of exported names, their types, and the frozen
   `StorageError.code` discriminants ([`docs/ERROR-CATALOG.md`](ERROR-CATALOG.md)) are additive-only:
   new exports and new error codes may be introduced in a minor, but nothing already exported is
   removed or changed incompatibly, and no existing `code` string is renamed or repurposed, in a
   minor or a patch. The `code` values are a machine-facing part of the public API (a caught
   `StorageError` exposes a stable `code` and a machine-readable `retryable`), so the catalog is
   frozen under exactly the same rule as the type surface.

2. **Deprecate in a minor; remove only in a major.** A public export or error code is never
   removed outright within a major line. It is first marked deprecated in a **minor** release (with
   a documented replacement and a `@deprecated` TSDoc tag), continues to work for the remainder of
   that major line, and is removed **only in the next major** release. Consumers therefore always
   get at least one minor's notice, with the old and new surface coexisting, before anything they
   depend on disappears.

3. **A major may require a forward migration; there is no supported downgrade.** A new UmbraDB
   **major** MAY ship a schema change that requires running a forward-only migration
   (`runMigrations`) against an existing database before the new major will operate against it.
   Migrations are forward-only — there is no `down()`/rollback path (see the migration contract in
   [`docs/CONTRACT.md`](CONTRACT.md#2-forward-only--no-downgrade-migration-contract) and the schema
   reference [`docs/SCHEMA.md`](SCHEMA.md)). **Downgrading** a database that has been migrated to a
   newer major back to an older UmbraDB major is **not supported**: take a backup before a major
   upgrade (see the [backup/restore guidance](CONTRACT.md#6-backuprestore-guidance)) if you need a
   rollback option.

## Scope and pre-1.0 note

The version was held at `0.1.0` until the 1.0.0 tag; that bump has now been made as the tag step
(`package.json` and `package-lock.json` both read `1.0.0`). Everything
in this policy takes effect at the 1.0.0 tag, at which point the surface enumerated in the
`CHANGELOG.md` `1.0.0` entry becomes the frozen baseline these three commitments govern.
