import re,json,collections
D=json.load(open("/root/umbradb-tp-trace/data.json"))
T=collections.Counter(); onlyman=collections.defaultdict(list); nonexec=collections.Counter(); blocked=collections.defaultdict(list)
for ch,v in D.items():
    for r in v["rows"]:
        tags=set(re.findall(r"\[(unit|prop|CI|doc|manual)\]",r["ver"]))
        T[frozenset(tags)]+=1
        if tags=={"manual"}: onlyman[ch].append(r["id"])
        if not (tags & {"unit","prop","CI"}): nonexec[ch]+=1
        if re.search(r"\bB-[1-8]\b|blocked|Blocked|register entry|measurement gate",r["crit"]+r["req"]): blocked[ch].append(r["id"])
print("tag combos:")
for k,c in sorted(T.items(),key=lambda x:-x[1]): print("  ",sorted(k),c)
print("\n[manual]-only criteria per change:")
tot=0
for ch,v in onlyman.items(): print("  ",ch,len(v),v); tot+=len(v)
print("  TOTAL manual-only:",tot)
print("\nno-unit/prop/CI (doc and/or manual only) per change:",dict(nonexec),"total",sum(nonexec.values()))
print("\nblocked-on-measurement criteria per change:")
tb=0
for ch,v in blocked.items(): print("  ",ch,len(v),v); tb+=len(v)
print("  TOTAL:",tb)
