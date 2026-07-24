#!/usr/bin/env node
/**
 * G1 / acceptance A6-A8: packed-tarball install smoke test (task 7.1).
 *
 * Proves the frozen 1.0.0 surface actually resolves for a REAL consumer of the PUBLISHED package —
 * not the in-repo `src/`. It:
 *   1. `npm pack`s UmbraDB and asserts the tarball ships `dist/index.d.ts` (A6);
 *   2. installs that tarball into a THROWAWAY scratch project (never a real consumer app — the
 *      indexer-agnostic boundary, council/A ruling (b)) and confirms the declaration is present (A8);
 *   3. from the scratch project, `import { createClient, runMigrations, PgTemporalKV, StorageError }
 *      from "umbradb"`, runs `runMigrations` + a `PgTemporalKV.put`/`get` round-trip against a
 *      Testcontainers Postgres, and asserts the written value is read back (A7);
 *   4. asserts a deep import `umbradb/src/postgres/temporal-kv.js` FAILS to resolve with
 *      `ERR_PACKAGE_PATH_NOT_EXPORTED` — the strict `exports` map (A8).
 *
 * GATING (matches `bench-smoke.yml` / the other Docker-using flows): this is NOT part of the default
 * `vitest run` / conformance gate. It runs only via `npm run test:smoke` (which builds `dist/` first)
 * and its own CI workflow (`.github/workflows/pack-smoke.yml`) on a Docker-equipped runner. On a host
 * with no Docker it prints SKIP and exits 0, so it never breaks the no-Docker path. It depends on the
 * built `dist/` (task 3): `npm run test:smoke` runs `npm run build` first.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shell = process.platform === "win32";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell, ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function fail(msg) {
  console.error(`\npack-install smoke: FAIL — ${msg}`);
  process.exit(1);
}

function skip(msg) {
  console.log(`\npack-install smoke: SKIP — ${msg}`);
  process.exit(0);
}

// ---- 0. Docker present? (no-Docker path safety) -------------------------------------------------
if (run("docker", ["info", "--format", "{{.ServerVersion}}"]).status !== 0) {
  skip("Docker is not available; Testcontainers cannot start a Postgres (this gate needs Docker).");
}

// ---- 0b. dist/ built? (task 3 dependency) -------------------------------------------------------
for (const f of ["dist/index.js", "dist/index.d.ts"]) {
  if (!existsSync(join(repoRoot, f))) {
    fail(`${f} missing — run \`npm run build\` first (\`npm run test:smoke\` does this for you).`);
  }
}

const scratch = mkdtempSync(join(tmpdir(), "umbradb-smoke-"));
let tarballPath;
let container;

async function main() {
  // ---- 1. npm pack + assert dist/index.d.ts ships in the tarball (A6) ---------------------------
  const pack = run("npm", ["pack", "--json", "--pack-destination", scratch], { cwd: repoRoot });
  if (pack.status !== 0) fail(`npm pack failed:\n${pack.stderr}`);
  let packMeta;
  try {
    const jsonStart = pack.stdout.indexOf("[");
    packMeta = JSON.parse(pack.stdout.slice(jsonStart));
  } catch (e) {
    fail(`could not parse \`npm pack --json\` output: ${String(e)}\n${pack.stdout}`);
  }
  const entry = packMeta[0];
  tarballPath = join(scratch, entry.filename);
  const shippedPaths = (entry.files ?? []).map((f) => f.path);
  if (!shippedPaths.includes("dist/index.d.ts")) {
    fail(`dist/index.d.ts is NOT in the packed tarball. Shipped:\n${shippedPaths.join("\n")}`);
  }
  console.log(`pack-install smoke: packed ${entry.filename} (dist/index.d.ts present in tarball).`);

  // ---- 2. install the tarball into the throwaway scratch project -------------------------------
  writeFileSync(
    join(scratch, "package.json"),
    `${JSON.stringify({ name: "umbradb-smoke-consumer", version: "0.0.0", private: true, type: "module" }, null, 2)}\n`,
  );
  const install = run(
    "npm",
    ["install", tarballPath, "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: scratch },
  );
  if (install.status !== 0) fail(`npm install of the tarball failed:\n${install.stderr}`);

  const installedDts = join(scratch, "node_modules", "umbradb", "dist", "index.d.ts");
  if (!existsSync(installedDts)) fail("installed package is missing dist/index.d.ts (A8).");
  console.log("pack-install smoke: tarball installed into scratch project; dist/index.d.ts present.");

  // ---- 3. deep import of an internal module MUST fail (strict exports map, A8) ------------------
  writeFileSync(
    join(scratch, "deep-import.mjs"),
    [
      "try {",
      "  await import('umbradb/src/postgres/temporal-kv.js');",
      "  console.error('DEEP_IMPORT_RESOLVED');",
      "  process.exit(5);",
      "} catch (e) {",
      "  if (e && e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') { console.log('DEEP_IMPORT_BLOCKED'); process.exit(0); }",
      "  console.error('DEEP_IMPORT_WRONG_ERROR ' + (e && e.code) + ' ' + String(e));",
      "  process.exit(6);",
      "}",
      "",
    ].join("\n"),
  );
  const deep = run(process.execPath, ["deep-import.mjs"], { cwd: scratch });
  if (deep.status !== 0 || !deep.stdout.includes("DEEP_IMPORT_BLOCKED")) {
    fail(`deep import of umbradb/src/postgres/temporal-kv.js was not blocked as expected:\n${deep.stdout}\n${deep.stderr}`);
  }
  console.log("pack-install smoke: deep import umbradb/src/postgres/temporal-kv.js correctly blocked (ERR_PACKAGE_PATH_NOT_EXPORTED).");

  // ---- 4. root import + runMigrations + put/get round-trip against Testcontainers Postgres (A7) -
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const connectionUri = container.getConnectionUri();

  writeFileSync(
    join(scratch, "consume.mjs"),
    [
      "import { createClient, runMigrations, PgTemporalKV, StorageError } from 'umbradb';",
      "if (typeof StorageError !== 'function') { console.error('StorageError is not a function'); process.exit(3); }",
      "const schema = 'smoke_test';",
      "const sql = createClient({ connectionString: process.env.DATABASE_URL, schema });",
      "try {",
      "  await runMigrations(sql, { schema });",
      "  const kv = new PgTemporalKV(sql);",
      "  const written = await kv.put('smoke', 'default', 'k', { n: 42, s: 'hello' });",
      "  if (written.version !== 1n) { console.error('unexpected version ' + written.version); process.exit(7); }",
      "  const read = await kv.get('smoke', 'default', 'k');",
      "  const ok = read && read.value && read.value.n === 42 && read.value.s === 'hello';",
      "  if (!ok) { console.error('round-trip mismatch: ' + JSON.stringify(read)); process.exit(4); }",
      "  console.log('SMOKE_OK ' + JSON.stringify(read.value));",
      "} finally {",
      "  await sql.end({ timeout: 5 });",
      "}",
      "",
    ].join("\n"),
  );
  const consume = run(process.execPath, ["consume.mjs"], {
    cwd: scratch,
    env: { ...process.env, DATABASE_URL: connectionUri },
  });
  if (consume.status !== 0 || !consume.stdout.includes("SMOKE_OK")) {
    fail(`consumer import + migrate + round-trip failed:\n${consume.stdout}\n${consume.stderr}`);
  }
  console.log(`pack-install smoke: root import + runMigrations + put/get round-trip OK — ${consume.stdout.trim().split("\n").pop()}`);
}

main()
  .then(async () => {
    console.log("\npack-install smoke: PASS — packed surface resolves for a fresh consumer; deep import blocked; .d.ts shipped.");
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    try { if (container) await container.stop(); } catch { /* best effort */ }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
    // Remove any stray tarball npm may have left in repoRoot (belt-and-suspenders; we pack into scratch).
    try {
      for (const f of readdirSync(repoRoot)) {
        if (/^umbradb-.*\.tgz$/.test(f)) rmSync(join(repoRoot, f), { force: true });
      }
    } catch { /* best effort */ }
  });
