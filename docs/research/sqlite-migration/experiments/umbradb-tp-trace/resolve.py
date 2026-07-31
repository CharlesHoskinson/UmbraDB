import re,json,unicodedata
D=json.load(open("/root/umbradb-tp-trace/data.json"))
SHORT={
"v1.0.0-sqlite-engine-core":{
 "PIN":"embedded SQLite database reached through a version-pinned",
 "WORKER":"owned by a dedicated worker thread",
 "TOKEN":"opaque token that cannot be used to reach",
 "OPTS":"connection factory opens exactly one database file",
 "BOOT":"pragma bootstrap is an ordered, once-only sequence",
 "BIND":"every bound parameter is normalised",
 "DECODE":"decoded from origin metadata",
 "INT64":"64-bit integer values round-trip",
 "TEXT":"text that SQLite stores incorrectly is rejected",
 "PARAMS":"more bound parameters than the engine accepts",
 "LIVE":"long read does not starve the main thread",
 "STREAM":"streamed across the worker boundary in batches",
 "GUARD":"per-row guard whose argument cannot be hoisted",
 "CANCEL":"statement deadlines are enforced in flight",
 "GATE":"every performance-dependent decision is blocked on measurements",
 "BLOCKED":"decisions blocked on the measurement gate are named",
 "CONFORM":"conformance suite is re-executed against the new engine"},
"v1.0.0-sqlite-temporal-event-log":{
 "EVT":"the event log is the only stored temporal representation",
 "GAP":"gap-freedom is structural",
 "APP":"the event log is append-only at the database level",
 "WF":"WellFormed is the single remaining refinement obligation",
 "CLK":"write-timestamp clock policy is decided by the engine-core",
 "TXK":"same-transaction key reuse is adapter-enforced",
 "REP":"never issues INSERT OR REPLACE",
 "ABT":"trigger assertions abort the statement",
 "QUA":"the naive EXCLUDE transliteration is prohibited",
 "CFG":"engine configuration under which trigger-based enforcement is sound"},
"v1.0.0-sqlite-data-migration":{
 "READONLY":"reads the source PostgreSQL database and never writes to it",
 "LINEAGE":"running the SQLite lineage to completion on an empty file",
 "RECON":"reconstructed from both source tables and the live version is never dropped",
 "PRECOND":"source preconditions are verified per key",
 "REFUSE":"encoding cannot represent is refused",
 "CKPT":"checkpoint manifest identifiers are preserved",
 "IDENT":"identifier array is exploded into the junction table",
 "NEWCON":"violates a constraint the target newly adds",
 "TWOART":"two distinct artifacts and are never conflated",
 "NASCOPE":"nothing in scope reports n/a and never pass",
 "TOOLDIAG":"tool diagnostics with a stable exit code",
 "JSON":"canonical text and never through a JavaScript",
 "TIME":"exact millisecond integer under pinned session settings",
 "NOTMINE":"belonging to the target lineage are produced by the lineage",
 "BUNDLE":"single read-only snapshot and the bundle is self-describing",
 "LADDER":"ladder of five rungs whose pass is their conjunction",
 "REPLAY":"established exhaustively over the breakpoint set",
 "DIGEST":"digest regime and introduces no second mechanism",
 "ATOMIC":"never leaves a database that presents itself as complete",
 "RERUN":"re-running the migration is safe",
 "NOWEAKEN":"does not weaken any check in order to go faster",
 "ROLLBACK":"supported rollback is the untouched source database",
 "CHANNELS":"each distribution channel has a written procedure",
 "DISCLOSE":"differences that survive a faithful migration are disclosed",
 "NONUMBERS":"no migration duration or throughput figure is asserted"}}
def norm(s):
    s=unicodedata.normalize("NFKD",s)
    s=s.replace("’","").replace("‘","").replace("“","").replace("”","")
    s=s.replace("’","").replace("‘","").replace("'","")
    s=s.replace("…"," ").replace("...", " ").replace("`","").replace("*","").replace("—"," ")
    s=re.sub(r"[^a-z0-9 ]"," ",s.lower())
    return re.sub(r"\s+"," ",s).strip()
out={}
for ch,v in D.items():
    titles=[t for _,t in v["reqs"]]
    ntitles=[norm(t) for t in titles]
    cov={t:[] for t in titles}
    unres=[]
    prev=[]
    for r in v["rows"]:
        req=r["req"].split("/")[0].strip()
        hits=set()
        # short names
        for k,frag in SHORT.get(ch,{}).items():
            if re.search(r"\b"+k+r"\b",req):
                nf=norm(frag)
                for t,nt in zip(titles,ntitles):
                    if nf in nt: hits.add(t)
        # quoted fragments
        for frag in re.findall(r"[“\"]([^”\"]{8,})[”\"]",r["req"]):
            parts=[norm(p) for p in re.split(r"…|\.\.\.",frag) if len(norm(p))>6]
            got=False
            for t,nt in zip(titles,ntitles):
                if parts and all(p in nt for p in parts): hits.add(t); got=True
            if not got and parts:
                toks=set(" ".join(parts).split())
                best=[];bs=0
                for t,nt in zip(titles,ntitles):
                    st=set(nt.split()); sc=len(toks&st)/max(1,len(toks))
                    if sc>bs: bs=sc;best=[t]
                    elif sc==bs: best.append(t)
                if bs>=0.72 and len(best)==1: hits.add(best[0])
        if not hits and re.search(r"\bsame\b",req,re.I): hits=set(prev)
        if hits: prev=list(hits)
        r["reqs"]=sorted(hits)
        if hits:
            for t in hits: cov[t].append(r["id"])
        else:
            unres.append((r["id"],r["req"]))
    out[ch]=dict(cov=cov,unres=unres,rows=v["rows"])
    miss=[t for t,c in cov.items() if not c]
    print("==",ch,"| uncovered reqs:",len(miss),"of",len(titles),"| unresolved criteria:",len(unres))
    for t in miss: print("    MISS:",t)
json.dump(out,open("/root/umbradb-tp-trace/cov.json","w"),indent=1)
