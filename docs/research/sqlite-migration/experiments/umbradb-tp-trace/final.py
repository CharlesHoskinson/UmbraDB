import re,json,unicodedata,collections
exec(open("/root/umbradb-tp-trace/resolve.py").read().split("out={}")[0])
ALIAS={
"v1.0.0-sqlite-temporal-event-log":{
 "T1":"Unconditional writes are gapless and monotonic",
 "T3":"temporal-projection equivalence",
 "T4":"Dual addressing agrees at recorded write timestamps",
 "T5":"History intervals never overlap",
 "CAS":"CAS guard distinguishes conflict from absence",
 "listKeys":"listKeys streams without materializing",
 "opts.tx":"caller-supplied transaction handle is honored or rejected",
 "I-3":"asserts the at bound through the primary-key index",
 "gap-boundary":"structural gap-freedom guarantee is a property of the encoding"}}
for ch,m in ALIAS.items(): SHORT.setdefault(ch,{}).update(m)
out={}
TOT=collections.Counter()
for ch,v in D.items():
    titles=[t for _,t in v["reqs"]]; ntitles=[norm(t) for t in titles]
    cov={t:[] for t in titles}; unres=[]; prev=[]
    for r in v["rows"]:
        req=r["req"].split("/")[0].strip(); hits=set()
        if ch=="v1.0.0-sqlite-temporal-event-log" and re.match(r"^all$",req): hits=set(titles)
        for k,frag in SHORT.get(ch,{}).items():
            if re.search(r"(?<![A-Za-z0-9])"+re.escape(k)+r"(?![A-Za-z0-9])",req):
                nf=norm(frag)
                for t,nt in zip(titles,ntitles):
                    if nf in nt: hits.add(t)
        for frag in re.findall(r"[“\"]([^”\"]{8,})[”\"]",r["req"]):
            parts=[norm(p) for p in re.split(r"…|\.\.\.",frag) if len(norm(p))>6]
            got=False
            for t,nt in zip(titles,ntitles):
                if parts and all(p in nt for p in parts): hits.add(t); got=True
            if not got and parts:
                toks=set(" ".join(parts).split()); best=[];bs=0
                for t,nt in zip(titles,ntitles):
                    st=set(nt.split()); sc=len(toks&st)/max(1,len(toks))
                    if sc>bs: bs=sc;best=[t]
                    elif sc==bs: best.append(t)
                if bs>=0.6 and len(best)==1: hits.add(best[0])
        if not hits and re.search(r"\bsame\b",req,re.I): hits=set(prev)
        if hits: prev=list(hits)
        r["reqs"]=sorted(hits)
        if hits:
            for t in hits: cov[t].append(r["id"])
        else: unres.append((r["id"],r["req"],r["ver"]))
    out[ch]=dict(cov=cov,unres=unres,rows=v["rows"],titles=titles)
    miss=[t for t,c in cov.items() if not c]
    TOT["reqs"]+=len(titles); TOT["miss"]+=len(miss); TOT["crit"]+=len(v["rows"]); TOT["unres"]+=len(unres)
    print("==",ch,"|",len(titles),"reqs |",len(miss),"unanchored |",len(v["rows"]),"criteria |",len(unres),"criteria not anchored to a requirement")
    for t in miss: print("    UNANCHORED REQ:",t)
    # requirements whose criteria are all doc/manual
    hard=[]
    for t,ids in cov.items():
        if not ids: continue
        tags=set()
        for r in v["rows"]:
            if t in r["reqs"]: tags|=set(re.findall(r"\[(unit|prop|CI|doc|manual)\]",r["ver"]))
        if not (tags & {"unit","prop"}):
            hard.append((t,sorted(tags),ids))
    for t,tg,ids in hard: print("    NO-EXECUTABLE-TEST REQ:",t,"|tags",tg,"|crit",ids)
    TOT["noexec"]+=len(hard)
print("TOTALS",dict(TOT))
json.dump({k:{"cov":v["cov"],"unres":v["unres"],"titles":v["titles"]} for k,v in out.items()},open("/root/umbradb-tp-trace/final.json","w"),indent=1)
