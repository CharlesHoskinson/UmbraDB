// T4b: guard UDF invocation count + row-dependent-argument variant + real abort test.
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');

if (isMainThread) {
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const w = new Worker(__filename, { workerData: { sab } });
  let t0;
  w.on('message', (m) => {
    if (m.ready) { t0 = Date.now(); setTimeout(() => Atomics.store(flag, 0, 1), 100); }
    else if (m.phase) { console.log(m.phase + ':', JSON.stringify(m)); if (m.phase === 'P3') w.terminate(); }
  });
} else {
  const Database = require('/tmp/l3-bs3b/node_modules/better-sqlite3');
  const flag = new Int32Array(workerData.sab);
  const db = new Database('/root/fable-adj2/t4.db');
  db.pragma('journal_mode = WAL');
  let calls = 0;
  db.function('udb_guard', { deterministic: false }, (x) => {
    calls++;
    if (Atomics.load(flag, 0) === 1) throw new Error('UDB_ABORTED');
    return 1;
  });
  // P1: row-INDEPENDENT call, flag never set yet -- how many invocations over 9M rows?
  calls = 0;
  db.prepare('SELECT count(*) c FROM big a, big b WHERE udb_guard(0) = 1').get();
  parentPort.postMessage({ phase: 'P1', form: 'udb_guard(0) constant arg', rows: 9e6, invocations: calls });
  // P2: row-DEPENDENT call -- invocations?  (smaller join so it stays bounded pre-abort test)
  calls = 0;
  db.prepare('SELECT count(*) c FROM big a, big b WHERE a.id <= 300 AND udb_guard(a.id + b.id) = 1').get();
  parentPort.postMessage({ phase: 'P2', form: 'udb_guard(a.id+b.id) row-dependent', rows: 300 * 3000, invocations: calls });
  // P3: abort-for-real: long row-dependent statement, main flips flag at +100ms
  parentPort.postMessage({ ready: true });
  const t0 = Date.now();
  calls = 0;
  try {
    db.prepare('SELECT count(*) c FROM big a, big b WHERE udb_guard(a.id + b.id) = 1').get();
    parentPort.postMessage({ phase: 'P3', outcome: 'COMPLETED (not aborted)', ms: Date.now() - t0, invocations: calls });
  } catch (e) {
    parentPort.postMessage({ phase: 'P3', outcome: 'ABORTED', err: e.message, ms: Date.now() - t0, invocations: calls });
  }
}
