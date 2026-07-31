import { createRequire } from "node:module";
const require = createRequire("/tmp/l3-bs3b/");
const Database = require("better-sqlite3");
const d = new Database("/root/umbradb-sqlite-research/scratch-conformance/dbs2/stale.sqlite");
const q = (sql, ...a) => d.prepare(sql).all(...a);
console.log("v3 by PK:", JSON.stringify(q("SELECT written_at FROM kv_event WHERE ns='ns' AND scope='sc' AND key='k' AND version=3")));
console.log("all rows in PK order:", JSON.stringify(q("SELECT version,written_at FROM kv_event ORDER BY ns,scope,key,version")));
const SEL = "SELECT version, written_at FROM kv_event %I WHERE ns='ns' AND scope='sc' AND key='k' AND written_at <= 4500 ORDER BY written_at DESC LIMIT 1";
for (const [label, hint] of [["NOT INDEXED", "NOT INDEXED"], ["INDEXED BY time", "INDEXED BY kv_event_time"], ["planner choice", ""]]) {
  const sql = SEL.replace("%I", hint);
  console.log(label, "->", JSON.stringify(q(sql)), "| plan:", JSON.stringify(q("EXPLAIN QUERY PLAN " + sql).map((r) => r.detail)));
}
