import re, os, json, sys
base="/root/UDB-sqlite-sprint/openspec/changes"
changes=["v1.0.0-sqlite-engine-core","v1.0.0-sqlite-temporal-event-log","v1.0.0-sqlite-concurrency-lease","v1.0.0-sqlite-schema-parity","v1.0.0-sqlite-durability-contract","v1.0.0-sqlite-chain-archive","v1.0.0-sqlite-data-migration"]

def reqs(ch):
    out=[]
    d=os.path.join(base,ch,"specs")
    for root,_,fs in os.walk(d):
        for f in sorted(fs):
            if f.endswith(".md"):
                p=os.path.join(root,f)
                for line in open(p,encoding="utf-8"):
                    m=re.match(r"^### Requirement:\s*(.+?)\s*$",line)
                    if m: out.append((os.path.relpath(p,os.path.join(base,ch)),m.group(1)))
    return out

def rows(ch):
    out=[];sect=None
    for line in open(os.path.join(base,ch,"acceptance.md"),encoding="utf-8"):
        m=re.match(r"^##+\s+(.+)$",line)
        if m: sect=m.group(1).strip()
        m=re.match(r"^\|\s*([A-Za-z][A-Za-z0-9-]{0,8})\s*\|(.+)\|(.+)\|(.+)\|\s*$",line)
        if m and "---" not in line:
            cid,crit,ver,req=m.group(1),m.group(2).strip(),m.group(3).strip(),m.group(4).strip()
            if cid in ("#",): continue
            out.append(dict(sect=sect,id=cid,crit=crit,ver=ver,req=req))
    return out

data={}
for ch in changes:
    R=reqs(ch); A=rows(ch)
    data[ch]=dict(reqs=R,rows=A)
    print("===",ch,"reqs",len(R),"criteria",len(A))
json.dump({k:{"reqs":v["reqs"],"rows":v["rows"]} for k,v in data.items()},open("/root/umbradb-tp-trace/data.json","w"),indent=1)
