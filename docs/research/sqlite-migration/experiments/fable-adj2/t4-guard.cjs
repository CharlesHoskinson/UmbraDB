// T4: the only named cancellation mechanism (SharedArrayBuffer flag polled by a guard UDF)
// -- does it actually abort a row-visiting statement on better-sqlite3@13.0.2?
// Main thread flips the flag; worker is synchronously blocked inside SQLite.
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');

if (isMainThread) {
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const w = new Worker(__filename, { workerData: { sab } });
  const t0 = Date.now();
  w.on('message', (m) => {
    if (m.ready) {
      setTimeout(() => { Atomics.store(flag, 0, 1); console.log('main: flag set at +' + (Date.now() - t0) + 'ms'); }, 300);
    } else {
      console.log('worker result:', JSON.stringify(m));
      console.log('abort latency after flag: ~' + (Date.now() - t0 - 300) + 'ms');
      w.terminate();
    }
  });
} else {
  const Database = require('/tmp/l3-bs3b/node_modules/better-sqlite3');
  const flag = new Int32Array(workerData.sab);
  const db = new Database('/root/fable-adj2/t4.db');
  db.pragma('journal_mode = WAL');
  db.exec('DROP TABLE IF EXISTS big; CREATE TABLE big (id INTEGER PRIMARY KEY, x TEXT)');
  const ins = db.prepare('INSERT INTO big (x) VALUES (?)');
  const tx = db.transaction(() => { for (let i = 0; i < 3000; i++) ins.run('r' + i); });
  tx();
  // guard UDF: reads the SAB; throwing from a UDF aborts the statement.
  db.function('udb_guard', { deterministic: false }, () => {
    if (Atomics.load(flag, 0) === 1) throw new Error('UDB_ABORTED');
    return 1;
  });
  parentPort.postMessage({ ready: true });
  const t0 = Date.now();
  try {
    // 3000 x 3000 cross join = 9M guard invocations; guard must appear in the SQL text.
    const row = db.prepare('SELECT count(*) c FROM big a, big b WHERE udb_guard() = 1').get();
    parentPort.postMessage({ outcome: 'COMPLETED (not aborted)', c: row.c, ms: Date.now() - t0 });
  } catch (e) {
    parentPort.postMessage({ outcome: 'ABORTED', err: e.message, ms: Date.now() - t0 });
  }
}
