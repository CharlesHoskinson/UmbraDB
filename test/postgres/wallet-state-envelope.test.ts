import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointNotFoundError } from "../../src/interfaces/checkpoint-store.js";
import { ValidationError } from "../../src/interfaces/storage-errors.js";
import {
  decode, encode, ENVELOPE_VERSION, EnvelopeCorruptError, EnvelopeVersionUnsupportedError,
  type WalletStateEnvelope,
} from "../../src/interfaces/wallet-state-envelope.js";
import { PgCheckpointStore } from "../../src/postgres/checkpoint-store.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { PgTransactionLeaseLayer } from "../../src/postgres/transaction-lease.js";
import { PgWalletStateEnvelopeStore } from "../../src/postgres/wallet-state-envelope.js";
import { registerSuiteLifecycle, TEST_SCHEMA } from "./setup.js";

const { sql: getSql } = registerSuiteLifecycle();

function checkpointStore(): PgCheckpointStore {
  const sql = getSql();
  return new PgCheckpointStore(sql, new PgTransactionLeaseLayer(sql), TEST_SCHEMA);
}

function envelopeStore(): PgWalletStateEnvelopeStore {
  return new PgWalletStateEnvelopeStore(checkpointStore());
}

function envelope(overrides: Partial<WalletStateEnvelope> = {}): WalletStateEnvelope {
  return {
    envelopeVersion: ENVELOPE_VERSION,
    walletId: "w1",
    networkId: "PreProd",
    subWallets: { shielded: null, unshielded: "unshielded-snapshot-1", dust: null },
    ...overrides,
  };
}

async function truncateAll(sql: UmbraDBSql): Promise<void> {
  await sql`TRUNCATE ${sql(TEST_SCHEMA)}.ckpt_manifest_chunks, ${sql(TEST_SCHEMA)}.ckpt_manifests, ${sql(TEST_SCHEMA)}.ckpt_chunks, ${sql(TEST_SCHEMA)}.ckpt_sequence_counters`;
}

describe("no wallet-SDK runtime import (structural conformance, specs/wallet-state-envelope/spec.md)", () => {
  it.each([
    "../../src/interfaces/wallet-state-envelope.ts",
    "../../src/postgres/wallet-state-envelope.ts",
  ])("%s imports nothing resolving to a @midnightntwrk/* package", (relPath) => {
    const path = fileURLToPath(new URL(relPath, import.meta.url));
    const source = readFileSync(path, "utf8");
    const importLines = source.split("\n").filter((line) => /^\s*import\b/.test(line));
    expect(importLines.length).toBeGreaterThan(0); // sanity: the file does import something
    for (const line of importLines) {
      expect(line).not.toMatch(/@midnightntwrk/);
    }
  });
});

describe("encode/decode (unit, Pg-free)", () => {
  it("round-trips all three sub-wallet strings and the version tag byte-for-byte", () => {
    const e = envelope({ subWallets: { shielded: "shielded-str", unshielded: "unshielded-str", dust: "dust-str" } });
    expect(decode(encode(e))).toEqual(e);
  });

  it("round-trips an envelope with all three sub-wallets absent/null", () => {
    const e = envelope({ subWallets: { shielded: null, unshielded: null, dust: null } });
    expect(decode(encode(e))).toEqual(e);
  });

  it("does not parse or alter a sub-wallet string's internal content across a round-trip", () => {
    const opaque = JSON.stringify({ looksLikeJson: true, nested: { a: 1 } });
    const e = envelope({ subWallets: { shielded: opaque, unshielded: null, dust: null } });
    const decoded = decode(encode(e));
    expect(decoded.subWallets.shielded).toBe(opaque); // exact same string, not re-serialized
  });

  it("rejects non-JSON bytes with EnvelopeCorruptError, not a raw SyntaxError", () => {
    const garbage = new TextEncoder().encode("not json {{{");
    try {
      decode(garbage);
      expect.fail("expected decode to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeCorruptError);
      expect(err).not.toBeInstanceOf(SyntaxError);
    }
  });

  it("rejects valid JSON missing envelopeVersion with EnvelopeCorruptError, not a malformed envelope", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      walletId: "w", networkId: "n", subWallets: { shielded: null, unshielded: null, dust: null },
    }));
    expect(() => decode(bytes)).toThrow(EnvelopeCorruptError);
  });

  it("rejects valid JSON with a non-string sub-wallet slot with EnvelopeCorruptError", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      envelopeVersion: ENVELOPE_VERSION, walletId: "w", networkId: "n",
      subWallets: { shielded: 123, unshielded: null, dust: null },
    }));
    expect(() => decode(bytes)).toThrow(EnvelopeCorruptError);
  });

  it("rejects an envelopeVersion greater than the current known version with EnvelopeVersionUnsupportedError, not a best-effort restore", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      envelopeVersion: ENVELOPE_VERSION + 1, walletId: "w", networkId: "n",
      subWallets: { shielded: null, unshielded: "x", dust: null },
    }));
    try {
      decode(bytes);
      expect.fail("expected decode to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeVersionUnsupportedError);
      expect((err as EnvelopeVersionUnsupportedError).foundVersion).toBe(ENVELOPE_VERSION + 1);
      expect((err as EnvelopeVersionUnsupportedError).supportedVersion).toBe(ENVELOPE_VERSION);
    }
  });

  it("encode rejects an envelope failing its schema with ValidationError", () => {
    const bad = {
      envelopeVersion: ENVELOPE_VERSION, walletId: "", networkId: "n",
      subWallets: { shielded: null, unshielded: null, dust: null },
    } as unknown as WalletStateEnvelope;
    expect(() => encode(bad)).toThrow(ValidationError);
  });
});

describe("PgWalletStateEnvelopeStore (Pg-only, required gate)", () => {
  afterEach(async () => {
    await truncateAll(getSql());
  });

  it("save then load (no sequence) returns an envelope equivalent to the one saved", async () => {
    const store = envelopeStore();
    const e = envelope();
    await store.save("w1", "PreProd", e);
    const loaded = await store.load("w1", "PreProd");
    expect(loaded).toEqual(e);
  });

  it("save issues exactly one CheckpointStore.save for the whole bundle (design.md §1)", async () => {
    const store = envelopeStore();
    const ckpt = checkpointStore();
    await store.save("w1", "PreProd", envelope());
    const history = await ckpt.history("w1", "PreProd");
    expect(history).toHaveLength(1);
  });

  it("load by explicit sequence returns the envelope saved at that sequence; omitting it returns the latest", async () => {
    const store = envelopeStore();
    const first = envelope({ subWallets: { shielded: null, unshielded: "v1", dust: null } });
    const second = envelope({ subWallets: { shielded: null, unshielded: "v2", dust: null } });
    await store.save("w1", "PreProd", first);
    await store.save("w1", "PreProd", second);

    const loadedFirst = await store.load("w1", "PreProd", 1);
    const loadedLatest = await store.load("w1", "PreProd");
    expect(loadedFirst.subWallets.unshielded).toBe("v1");
    expect(loadedLatest.subWallets.unshielded).toBe("v2");
  });

  it("load for a (walletId, networkId) never saved rejects with CheckpointNotFoundError, not a default/empty envelope", async () => {
    const store = envelopeStore();
    await expect(store.load("nobody", "nowhere")).rejects.toBeInstanceOf(CheckpointNotFoundError);
  });

  // L3: an envelope save/load bundling 2+ opaque sub-wallet strings, each surviving independently.
  it("L3: bundling 2+ opaque sub-wallet strings in one save/load, each survives independently", async () => {
    const store = envelopeStore();
    const e = envelope({
      walletId: "w-l3",
      subWallets: { shielded: "shielded-payload-A", unshielded: "unshielded-payload-B", dust: null },
    });
    await store.save("w-l3", "PreProd", e);
    const loaded = await store.load("w-l3", "PreProd");
    expect(loaded.subWallets.shielded).toBe("shielded-payload-A");
    expect(loaded.subWallets.unshielded).toBe("unshielded-payload-B");
    expect(loaded.subWallets.dust).toBeNull();
  });

  it("L3b: all three sub-wallet strings populated in one bundle each survive independently", async () => {
    const store = envelopeStore();
    const e = envelope({
      walletId: "w-l3b",
      subWallets: { shielded: "S-payload", unshielded: "U-payload", dust: "D-payload" },
    });
    await store.save("w-l3b", "PreProd", e);
    const loaded = await store.load("w-l3b", "PreProd");
    expect(loaded.subWallets).toEqual({ shielded: "S-payload", unshielded: "U-payload", dust: "D-payload" });
  });

  it("load rejects with EnvelopeCorruptError when the stored envelope's echoed (walletId, networkId) does not match the requested key", async () => {
    const store = envelopeStore();
    const mismatched = envelope({ walletId: "someone-else", networkId: "PreProd" });
    await store.save("w-mismatch", "PreProd", mismatched);
    await expect(store.load("w-mismatch", "PreProd")).rejects.toBeInstanceOf(EnvelopeCorruptError);
  });
});
