import { defineConfig } from "vitest/config";

/**
 * Narrow vitest config used ONLY by StrykerJS (`stryker.conf.json` → `vitest.configFile`).
 *
 * Mutation testing runs a mutated file's covering tests once PER mutant, so it must run a TIGHT,
 * fast covering-test set — never the whole conformance suite (property/crash/soak/differential
 * suites are excluded). §2.3 requires mutation on **at least the four durability adapters**; this
 * change mutates FIVE (`save-and-advance`, `checkpoint-store`, `watermarks`, `transaction-lease`,
 * `temporal-kv`), each paired with ITS OWN fast `.test.ts` unit suite here. StrykerJS's per-test
 * coverage analysis (`coverageAnalysis: "perTest"`) then reruns, per mutant, only the tests that
 * actually cover it — so adding these files does not make every mutant rerun every suite. Each
 * suite shares ONE Testcontainers Postgres started once at the dry run and reused across mutants.
 * Coverage instrumentation is intentionally OFF here (it would collide with Stryker's own mutant
 * instrumentation and is irrelevant to a mutation run).
 */
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    include: [
      "test/postgres/save-and-advance.test.ts",
      "test/postgres/checkpoint-store.test.ts",
      "test/postgres/watermarks.test.ts",
      "test/postgres/transaction-lease.test.ts",
      "test/postgres/temporal-kv.test.ts",
    ],
  },
});
