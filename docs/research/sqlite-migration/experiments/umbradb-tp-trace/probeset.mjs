// Builds the V5a probe set exactly as v1.0.0-sqlite-data-migration REPLAY / design §9.3 specifies,
// and compares its size against acceptance criterion H6 bound 2|B|+1.
function probes(sourceBoundaries, targetWrittenAt, n) {
  const B = [...new Set([...sourceBoundaries, ...targetWrittenAt])].sort((a,b)=>a-b);
  const at = new Set(B);
  for (let i=0;i<B.length-1;i++) if (B[i+1]-B[i] > 1) at.add(B[i]+1);
  at.add(B[0]-1);                       // one instant before the earliest
  const ver = new Set([0, n+1]);        // plus every version in 1..n
  for (let v=1;v<=n;v++) ver.add(v);
  return {B, at: at.size, ver: ver.size, total: at.size+ver.size, bound: 2*B.length+1};
}
const cases = [
  ["n=1, kv_current only @1000",            [1000], [1000], 1],
  ["n=2, contiguous 1000/2000",             [1000,2000], [1000,2000], 2],
  ["n=3, contiguous 1000/2000/3000",        [1000,2000,3000], [1000,2000,3000], 3],
  ["n=3, adjacent ms 1000/1001/1002",       [1000,1001,1002], [1000,1001,1002], 3],
  ["n=10 spaced by 1000",                   Array.from({length:10},(_,i)=>1000*(i+1)), Array.from({length:10},(_,i)=>1000*(i+1)), 10],
];
for (const [name,s,t,n] of cases) {
  const r = probes(s,t,n);
  console.log(`${name.padEnd(38)} |B|=${String(r.B.length).padStart(2)}  at=${String(r.at).padStart(2)}  ver=${String(r.ver).padStart(2)}  total=${String(r.total).padStart(2)}  bound(2|B|+1)=${String(r.bound).padStart(2)}  at<=bound:${r.at<=r.bound}  total<=bound:${r.total<=r.bound}`);
}
