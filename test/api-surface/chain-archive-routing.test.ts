import { describe, expect, it } from "vitest";
import {
  ChainArchiveCheckViolationError,
  ChainArchiveInvariantError,
  ClockRegressionError,
  translatePostgresError,
} from "../../src/postgres/errors.js";

/**
 * G3 / acceptance C8 + C9: excluding the chain-archive classes from the FROZEN surface must not
 * break translatePostgresError's INTERNAL 23514 constraint-name routing. These are pure-unit
 * checks over synthetic driver-error objects (matching the negative-control shape in
 * errors.test.ts) -- no database required -- confirming the routing is preserved and the
 * fall-through to ClockRegressionError for an unrecognized constraint name is unchanged.
 */
function fakeDriverError(constraintName?: string): Error {
  const base: Record<string, unknown> = { code: "23514", severity: "ERROR" };
  if (constraintName !== undefined) base.constraint_name = constraintName;
  return Object.assign(new Error("check_violation"), base);
}

describe("translatePostgresError still routes chain-archive 23514s internally (C8, C9)", () => {
  it("a chain-archive INVARIANT trigger name routes to ChainArchiveInvariantError (C8)", () => {
    const t = translatePostgresError(fakeDriverError("chain_blob_roles_completeness"));
    expect(t).toBeInstanceOf(ChainArchiveInvariantError);
    expect((t as ChainArchiveInvariantError).constraintName).toBe("chain_blob_roles_completeness");
    expect(t).not.toBeInstanceOf(ClockRegressionError);
  });

  it("an ordinary chain-archive table CHECK name routes to ChainArchiveCheckViolationError (C8)", () => {
    const t = translatePostgresError(fakeDriverError("blocks_status_check"));
    expect(t).toBeInstanceOf(ChainArchiveCheckViolationError);
    expect((t as ChainArchiveCheckViolationError).constraintName).toBe("blocks_status_check");
    expect(t).not.toBeInstanceOf(ClockRegressionError);
  });

  it("an unrecognized 23514 constraint name (temporal-kv kv_history_range) still falls through to ClockRegressionError (C9)", () => {
    const t = translatePostgresError(fakeDriverError("kv_history_range"));
    expect(t).toBeInstanceOf(ClockRegressionError);
    expect(t).not.toBeInstanceOf(ChainArchiveInvariantError);
    expect(t).not.toBeInstanceOf(ChainArchiveCheckViolationError);
  });

  it("a 23514 with NO constraint name falls through to ClockRegressionError (C9)", () => {
    const t = translatePostgresError(fakeDriverError(undefined));
    expect(t).toBeInstanceOf(ClockRegressionError);
  });

  it("the routed chain-archive classes carry a machine-readable retryable field (non-retryable)", () => {
    const inv = translatePostgresError(fakeDriverError("blocks_finalized_monotonic")) as ChainArchiveInvariantError;
    expect(inv.retryable).toBe("non-retryable");
  });
});
