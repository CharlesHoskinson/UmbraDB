import { execFileSync } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createClient, type UmbraDBSql } from "../src/postgres/client.js";
import { runMigrations } from "../src/postgres/migrate.js";

/** The bench schema — isolated from the test suite's `umbradb_test` so a bench run never collides
 *  with a test container reusing the same daemon. */
export const BENCH_SCHEMA = "umbradb_bench";

/**
 * Pinned Postgres image (`design.md` §4), pinned by DIGEST. This `postgres@sha256:742f40…2193` is
 * the exact 17-alpine image that produced the committed baseline, resolved from the local image
 * (`docker image inspect postgres:17-alpine` — its RepoDigest). The Testcontainers container now
 * STARTS from this digest, so the pin is enforced at run time rather than merely recorded after the
 * fact. The resolved local image id is still captured into the baseline's
 * `environment.postgresImageId` as corroboration. See `Performance/CEILINGS.md` for the pinning note.
 */
export const POSTGRES_IMAGE =
  "postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";

/** Server settings pinned for run-to-run comparability (`design.md` §4). */
export const PG_SETTINGS = {
  shared_buffers: "256MB",
  work_mem: "16MB",
  max_wal_size: "2GB",
} as const;

export interface BenchEnv {
  sql: UmbraDBSql;
  connectionUri: string;
  container: StartedPostgreSqlContainer;
  serverVersion: string;
  imageId: string | null;
  stop: () => Promise<void>;
}

/**
 * Start a Testcontainers PG17 with the pinned image + settings, connect via UmbraDB's own
 * {@link createClient} (so `types.bigint`/`search_path` are configured exactly as production), and
 * run every migration (000..006, including IS-1 `005` fillfactor + IS-2 `006` size_bytes). The
 * bench drives UmbraDB's OWN adapters against this real Postgres — never a consumer/indexer app
 * (indexer-agnostic boundary, `design.md` §7; roadmap G11).
 */
export async function startBenchEnv(maxConnections = 24): Promise<BenchEnv> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withCommand([
      "postgres",
      "-c", `shared_buffers=${PG_SETTINGS.shared_buffers}`,
      "-c", `work_mem=${PG_SETTINGS.work_mem}`,
      "-c", `max_wal_size=${PG_SETTINGS.max_wal_size}`,
      // Deterministic single-worker planning so a pass duration is not perturbed by the runner's
      // core count (comparability, not a production recommendation).
      "-c", "max_parallel_workers_per_gather=0",
    ])
    .start();

  const connectionUri = container.getConnectionUri();
  const sql = createClient({ connectionString: connectionUri, schema: BENCH_SCHEMA, maxConnections });
  await runMigrations(sql, { schema: BENCH_SCHEMA });

  const versionRows = await sql<{ version: string }[]>`SELECT version()`;
  const serverVersion = versionRows[0]?.version ?? "unknown";

  let imageId: string | null = null;
  try {
    imageId =
      execFileSync("docker", ["inspect", "--format", "{{.Image}}", container.getId()], {
        encoding: "utf8",
      }).trim() || null;
  } catch {
    imageId = null;
  }

  return {
    sql,
    connectionUri,
    container,
    serverVersion,
    imageId,
    stop: async () => {
      await sql.end({ timeout: 5 });
      await container.stop();
    },
  };
}
