import { describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

const { connectionUri } = registerSuiteLifecycle();

/**
 * P10 (`Formal/STORAGE_ALGEBRA.md` §5, Law L1 — mutual exclusion): concurrent `withLease` calls
 * on one key, from MULTIPLE INDEPENDENT connections (not just multiple in-process callers on one
 * shared client — `openspec/changes/sprint-2-transaction-lease/design.md` §6 notes this is the
 * connection-scoped guarantee `pg_advisory_lock` actually provides, matching Sprint 1's own P1
 * property test's identical in-process-vs-multi-process distinction). A shared, in-memory
 * counter incremented on entry and decremented on exit of the critical section, with the running
 * count and its historical maximum both instrumented, proves at most one critical section is
 * ever active regardless of how many independent connections race for the same key.
 */
describe("PgTransactionLeaseLayer property: at most one holder per lease key at any instant (Law L1)", () => {
  it("P10: N concurrent withLease calls from N independent connections never overlap", async () => {
    const CONNECTIONS = 8;
    const clients: UmbraDBSql[] = Array.from({ length: CONNECTIONS }, () =>
      createClient({ connectionString: connectionUri(), schema: TEST_SCHEMA, maxConnections: 2 }));

    let active = 0;
    let maxActive = 0;
    let overlapDetected = false;

    try {
      const layers = clients.map((sql) => new PgTransactionLeaseLayer(sql));
      await Promise.all(
        layers.map((layer) =>
          layer.withLease("p10-key", async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            if (active > 1) overlapDetected = true;
            // Hold the critical section briefly so overlapping acquisitions, if the mutual
            // exclusion guarantee were broken, would have a real window to actually collide in.
            await new Promise((r) => setTimeout(r, 20));
            active -= 1;
          }),
        ),
      );

      expect(overlapDetected).toBe(false);
      expect(maxActive).toBe(1);
    } finally {
      await Promise.all(clients.map((c) => c.end({ timeout: 5 })));
    }
  }, 30_000);
});
