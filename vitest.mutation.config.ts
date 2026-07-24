import { defineConfig } from "vitest/config";

/**
 * Narrow vitest config used ONLY by StrykerJS (`stryker.conf.json` → `vitest.configFile`).
 *
 * Mutation testing runs the mutated file's tests once PER mutant, so it must run a TIGHT, fast
 * covering-test set — never the whole conformance suite. For the `save-and-advance.ts` durability
 * combinator that is `save-and-advance.test.ts` (the A6/A7 co-commit / rollback assertions), which
 * uses one shared Testcontainers Postgres. Coverage instrumentation is intentionally OFF here (it
 * would collide with Stryker's own mutant instrumentation and is irrelevant to a mutation run).
 */
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    include: ["test/postgres/save-and-advance.test.ts"],
  },
});
