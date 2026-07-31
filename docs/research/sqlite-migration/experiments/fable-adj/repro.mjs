// Fable adjudication — independent reproduction of opus-evidence C1.
// Question: does an open-then-close of a descriptor on the -shm file, inside the
// process holding BEGIN IMMEDIATE, void SQLite's WAL write lock so that a second
// OS process can commit inside the holder's transaction — and is one acknowledged
// commit then silently lost with integrity_check still "ok"?
import Database from "/tmp/l3-bs3b/node_modules/better-sqlite3/lib/index.js";
import { spawn } from "node:child_process";
import fs from "node:fs";

const out = (k, v) => console.log(String(k).padEnd(52), v);

async function run(action) {
  const dir = `/root/fable-adj/wk-${action}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const p = `${dir}/main.db`;

  const holder = spawn(process.execPath, ["/root/fable-adj/holder.mjs", p, action],
    { stdio: ["pipe", "pipe", "inherit"] });
  const wait = (tok) => new Promise((res) => {
    const h = (b) => { if (String(b).includes(tok)) { holder.stdout.off("data", h); res(String(b)); } };
    holder.stdout.on("data", h);
  });

  await wait("HELD");                    // holder: BEGIN IMMEDIATE + insert, uncommitted
  holder.stdin.write("go\n");
  await wait("ACTED");                   // holder has performed the -shm action (or none)

  // Competitor: THIS process (a separate OS process from the holder).
  const c = new Database(p);
  c.pragma("busy_timeout = 0");
  let competitor;
  try {
    c.exec("begin immediate");
    c.exec("insert into t values (99)");
    c.exec("commit");
    competitor = "COMMITTED (ack ok)";
  } catch (e) {
    competitor = "refused " + e.code;
    try { c.exec("rollback"); } catch {}
  }
  c.close();

  holder.stdin.write("go\n");
  const holderCommit = (await wait("COMMIT")).trim();
  holder.stdin.write("go\n");
  holder.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 200));

  const f = new Database(p);
  const rows = f.prepare("select who from t order by who").all().map(r => r.who);
  const ic = f.pragma("integrity_check")[0].integrity_check;
  f.close();

  out(`[${action}] competitor`, competitor);
  out(`[${action}] holder`, holderCommit);
  out(`[${action}] final rows`, JSON.stringify(rows));
  out(`[${action}] integrity_check`, ic);
  const lost = competitor.startsWith("COMMITTED") && !rows.includes(99);
  out(`[${action}] acknowledged commit lost?`, lost ? "YES — SILENT LOSS" : "no");
  console.log("");
}

console.log("node", process.version, "| sqlite",
  new Database(":memory:").prepare("select sqlite_version() v").get().v,
  "| fs:", "/root is " + fs.readFileSync("/proc/mounts", "utf8").split("\n")
    .find(l => l.split(" ")[1] === "/")?.split(" ")[2]);
console.log("");

await run("none");           // control: lock must hold
await run("shm-openkeep");   // open -shm WITHOUT close: lock should hold if mechanism is fd-close
await run("shm-readclose");  // readFileSync -shm (open+close): the claimed attack
