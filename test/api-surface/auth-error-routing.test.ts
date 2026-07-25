import { describe, expect, it } from "vitest";
import { AuthenticationError, translatePostgresError } from "../../src/postgres/errors.js";
import { ConnectionError } from "../../src/interfaces/storage-errors.js";

/**
 * Error-model audit BLOCK 3: authentication failures (SQLSTATE 28000 / 28P01) must NOT be routed to
 * the retryable ConnectionError -- retrying the SAME rejected credential can never succeed. They
 * translate to the NON-retryable AuthenticationError; genuinely transient class-08 connection loss
 * (e.g. 08006) stays a retryable ConnectionError. Pure-unit checks over synthetic driver errors
 * (matching chain-archive-routing.test.ts's shape), no database required.
 */
function driverError(code: string): Error {
  // A synthetic driver error carrying only a SQLSTATE `.code` (no `.severity`) -- the recognition
  // set must still classify it, so a bare { code } suffices (the audit's synthetic { code } shape).
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

describe("translatePostgresError: auth failures are non-retryable (BLOCK 3)", () => {
  for (const code of ["28P01", "28000"]) {
    it(`${code} translates to a non-retryable AuthenticationError, not ConnectionError`, () => {
      const t = translatePostgresError(driverError(code));
      expect(t).toBeInstanceOf(AuthenticationError);
      expect(t).not.toBeInstanceOf(ConnectionError);
      expect((t as AuthenticationError).code).toBe("AUTHENTICATION_FAILED");
      expect((t as AuthenticationError).retryable).toBe("non-retryable");
    });
  }

  it("08006 (connection_failure) still translates to a retryable ConnectionError, unchanged", () => {
    const t = translatePostgresError(driverError("08006"));
    expect(t).toBeInstanceOf(ConnectionError);
    expect(t).not.toBeInstanceOf(AuthenticationError);
    expect((t as ConnectionError).code).toBe("CONNECTION_ERROR");
    expect((t as ConnectionError).retryable).toBe("retryable");
  });
});
