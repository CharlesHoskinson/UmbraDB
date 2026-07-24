import { describe, expect, it } from "vitest";
import { type Lease, LeaseFaultError } from "../../src/interfaces/transaction-lease.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

// G8 task 3.3 — withLease surfaces a lease-release failure instead of swallowing it
// (openspec/changes/v1.0.0-durable-checkpoint-cursor: design.md §4.3).

const { sql: getSql } = registerSuiteLifecycle();

// Injects a release fault the way a dead reserved connection would produce one: it actually
// releases the real lease (so the advisory lock is not leaked in the test), then throws the same
// LeaseFaultError("connection-lost") releaseLease throws when its unlock query fails. This is a
// direct unit-level injection of the release-fault condition (a genuine mid-run connection kill is
// not deterministically reproducible in CI); withLease's handling is what is under test.
class InjectedReleaseFaultLayer extends PgTransactionLeaseLayer {
  override async releaseLease(lease: Lease): Promise<void> {
    await super.releaseLease(lease).catch(() => {});
    throw new LeaseFaultError("injected release fault", "connection-lost");
  }
}

void TEST_SCHEMA;

describe("G8 withLease surfaces release faults (design.md §4.3)", () => {
  it("fn succeeds + no callback + release fails → withLease rejects with the fault", async () => {
    const layer = new InjectedReleaseFaultLayer(getSql());
    await expect(layer.withLease("g8-wl-1", async () => 42)).rejects.toBeInstanceOf(LeaseFaultError);
  }, 20_000);

  it("fn succeeds + callback supplied → callback invoked, withLease resolves with fn's value", async () => {
    const layer = new InjectedReleaseFaultLayer(getSql());
    let captured: unknown;
    const result = await layer.withLease("g8-wl-2", async () => 42, {
      onReleaseFault: (e) => { captured = e; },
    });
    expect(result).toBe(42);
    expect(captured).toBeInstanceOf(LeaseFaultError);
  }, 20_000);

  it("fn throws + release fails + no callback → fn's error is primary, release fault attached as cause", async () => {
    const layer = new InjectedReleaseFaultLayer(getSql());
    const fnError = new Error("fn boom");
    let caught: unknown;
    try {
      await layer.withLease("g8-wl-3", async () => { throw fnError; });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(fnError);
    expect((caught as Error).cause).toBeInstanceOf(LeaseFaultError);
  }, 20_000);

  it("fn throws + release fails + callback supplied → fn's error primary, release fault via callback", async () => {
    const layer = new InjectedReleaseFaultLayer(getSql());
    const fnError = new Error("fn boom 2");
    let captured: unknown;
    await expect(
      layer.withLease("g8-wl-4", async () => { throw fnError; }, { onReleaseFault: (e) => { captured = e; } }),
    ).rejects.toBe(fnError);
    expect(captured).toBeInstanceOf(LeaseFaultError);
  }, 20_000);

  it("clean release → resolves with fn's value and surfaces no fault", async () => {
    const layer = new PgTransactionLeaseLayer(getSql());
    let faulted = false;
    const result = await layer.withLease("g8-wl-5", async () => 7, {
      onReleaseFault: () => { faulted = true; },
    });
    expect(result).toBe(7);
    expect(faulted).toBe(false);
  }, 20_000);

  it("fn throws a FROZEN error + release fails -> both surfaced via AggregateError, fn's error not masked (F1)", async () => {
    const layer = new InjectedReleaseFaultLayer(getSql());
    const frozenError = Object.freeze(new Error("frozen business rule"));
    let caught: unknown;
    try {
      await layer.withLease("g8-wl-6", async () => {
        throw frozenError;
      });
    } catch (e) {
      caught = e;
    }
    // A frozen fn error cannot take a `cause`; withLease must still surface BOTH errors without
    // masking fn's own — via an AggregateError whose errors include fn's frozen error and the fault.
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toContain(frozenError);
    expect((caught as AggregateError).errors.some((e) => e instanceof LeaseFaultError)).toBe(true);
  }, 20_000);

  it("an async onReleaseFault that rejects does not derail fn's outcome or leak an unhandled rejection", async () => {
    const layer = new InjectedReleaseFaultLayer(getSql());
    const result = await layer.withLease("g8-wl-7", async () => 99, {
      onReleaseFault: (() => Promise.reject(new Error("async observer boom"))) as (e: unknown) => void,
    });
    // fn's value is still returned; the async callback's rejection is swallowed (no unhandled rejection).
    expect(result).toBe(99);
  }, 20_000);
});
