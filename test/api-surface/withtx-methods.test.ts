import { describe, expect, it } from "vitest";
import * as umbra from "../../src/index.js";
import { PgTransactionLeaseLayer, type UmbraDBSql } from "../../src/index.js";

/**
 * G1 / acceptance A1 (final clause) + Fable B2: withTransaction/withLease are async METHODS of
 * PgTransactionLeaseLayer (and its TransactionLeaseLayer interface), NOT standalone module-level
 * barrel exports. The freeze must not invent free-function wrappers for them.
 */
describe("withTransaction/withLease are methods of PgTransactionLeaseLayer, not standalone exports", () => {
  const barrel = umbra as unknown as Record<string, unknown>;

  it("neither name is a top-level barrel export", () => {
    expect("withTransaction" in barrel).toBe(false);
    expect("withLease" in barrel).toBe(false);
  });

  it("both are reachable as methods on the class prototype and on an instance", () => {
    expect(typeof PgTransactionLeaseLayer.prototype.withTransaction).toBe("function");
    expect(typeof PgTransactionLeaseLayer.prototype.withLease).toBe("function");
    // The constructor only stores its sql; it opens no connection until a method runs, so a dummy
    // handle is enough to prove instance-method reachability without a database.
    const layer = new PgTransactionLeaseLayer({} as unknown as UmbraDBSql);
    expect(typeof layer.withTransaction).toBe("function");
    expect(typeof layer.withLease).toBe("function");
  });
});
