import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/interfaces/storage-errors.js";
import { PgCheckpointStore } from "../../src/postgres/checkpoint-store.js";
import { createClient } from "../../src/postgres/client.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

// G8 task 3.1 — walletId/networkId validated at all four PgCheckpointStore entry points
// (openspec/changes/v1.0.0-durable-checkpoint-cursor: design.md §4.1).

const { sql: getSql } = registerSuiteLifecycle();

function makeStore() {
  const sql = getSql();
  return new PgCheckpointStore(sql, new PgTransactionLeaseLayer(sql), TEST_SCHEMA);
}

// Built via String.fromCharCode so the SOURCE file stays pure ASCII (a literal NUL / lone surrogate
// byte would make git treat this file as binary and unreviewable) while the runtime string still
// carries the byte PostgreSQL cannot store.
const NUL_ID = `wallet${String.fromCharCode(0)}id`;
const LONE_SURROGATE_ID = `wallet${String.fromCharCode(0xd800)}id`;
const OVERLONG_ID = "w".repeat(513);
const OK_ID = "wallet-ok";

type Method = "save" | "load" | "history" | "prune";
const invoke = (
  store: PgCheckpointStore,
  method: Method,
  walletId: string,
  networkId: string,
): Promise<unknown> => {
  switch (method) {
    case "save":
      return store.save(walletId, networkId, new Uint8Array([1, 2, 3]));
    case "load":
      return store.load(walletId, networkId);
    case "history":
      return store.history(walletId, networkId);
    case "prune":
      return store.prune(walletId, networkId, 1);
  }
};

const METHODS: Method[] = ["save", "load", "history", "prune"];

describe("G8 checkpoint id validation (design.md §4.1)", () => {
  for (const method of METHODS) {
    it(`${method}: a NUL-containing walletId rejects with ValidationError`, async () => {
      await expect(invoke(makeStore(), method, NUL_ID, "net")).rejects.toBeInstanceOf(ValidationError);
    });
    it(`${method}: a lone-surrogate networkId rejects with ValidationError`, async () => {
      await expect(invoke(makeStore(), method, "wallet", LONE_SURROGATE_ID)).rejects.toBeInstanceOf(ValidationError);
    });
    it(`${method}: an over-length walletId rejects with ValidationError`, async () => {
      await expect(invoke(makeStore(), method, OVERLONG_ID, "net")).rejects.toBeInstanceOf(ValidationError);
    });
  }

  it("a well-formed id path is unchanged for all four methods (regression)", async () => {
    const store = makeStore();
    // save succeeds with valid ids; the others do not throw ValidationError on a valid id
    // (load with no prior checkpoint throws the domain CheckpointNotFoundError, not ValidationError).
    await expect(store.save(OK_ID, "net-ok", new Uint8Array([9, 9, 9]))).resolves.toBeDefined();
    await expect(store.history(OK_ID, "net-ok")).resolves.toBeDefined();
    await expect(store.prune(OK_ID, "net-ok", 1)).resolves.toBeDefined();
    await expect(store.load(OK_ID, "net-ok")).resolves.toBeDefined(); // the checkpoint just saved
  }, 30_000);

  it("no statement is issued before rejection: a bad id fails with ValidationError even against an unreachable server", async () => {
    // Points at a closed port with a short connect timeout: if validation did NOT run first, save
    // would attempt to connect and reject with ConnectionError. Getting ValidationError instead
    // proves the id is validated before any statement / connection is issued.
    const badSql = createClient({ connectionString: "postgres://u:p@127.0.0.1:1/db", schema: TEST_SCHEMA, connectTimeout: 1 });
    try {
      const store = new PgCheckpointStore(badSql, new PgTransactionLeaseLayer(badSql), TEST_SCHEMA);
      await expect(store.save(NUL_ID, "net", new Uint8Array([1]))).rejects.toBeInstanceOf(ValidationError);
      // Positive half of the control: a VALID id against the SAME unreachable server gets PAST
      // validation and then fails trying to connect — a non-validation (connection/transaction)
      // error. That proves the server is genuinely unreachable, so the ValidationError above came
      // from validation running first, not a blanket rejection.
      await expect(store.save(OK_ID, "net", new Uint8Array([1]))).rejects.toSatisfy((e: unknown) => e instanceof Error && !(e instanceof ValidationError));
    } finally {
      await badSql.end({ timeout: 2 }).catch(() => {});
    }
  }, 15_000);
});
