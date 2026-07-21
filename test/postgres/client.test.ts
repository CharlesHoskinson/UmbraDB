import { describe, expect, it } from "vitest";
import { createClient } from "../../src/postgres/client.js";

describe("createClient (Codex re-audit finding: connectionString query params can override schema)", () => {
  it("rejects a connectionString with a search_path query parameter before ever connecting", () => {
    // No real Postgres needed: createClient's guard runs synchronously, before postgres() is
    // ever called, so this never touches the network.
    expect(() =>
      createClient({
        connectionString: "postgres://user:pass@127.0.0.1:1/db?search_path=public",
        schema: "tenant_a",
      }),
    ).toThrow(/search_path/);
  });

  it("accepts a connectionString with unrelated query parameters", () => {
    const sql = createClient({
      connectionString: "postgres://user:pass@127.0.0.1:1/db?sslmode=disable",
      schema: "tenant_a",
      maxConnections: 1,
    });
    try {
      expect(sql.umbradbSchema).toBe("tenant_a");
    } finally {
      void sql.end({ timeout: 1 });
    }
  });

  it("accepts a connectionString with no query string at all", () => {
    const sql = createClient({
      connectionString: "postgres://user:pass@127.0.0.1:1/db",
      schema: "tenant_a",
      maxConnections: 1,
    });
    try {
      expect(sql.umbradbSchema).toBe("tenant_a");
    } finally {
      void sql.end({ timeout: 1 });
    }
  });
});
