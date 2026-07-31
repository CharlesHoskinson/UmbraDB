"""Resolve dangling edge endpoints produced by the council chunk.

The council extraction agent was told to emit an edge even when unsure of the
exact lane node id, on the grounds that a dangling edge is more recoverable than
a missing one. This resolves those guesses to real node ids by token overlap
within the same file stem, and reports honestly what it could not match.
"""
import json
from pathlib import Path

OUT = Path('/root/umbradb-sqlite-research/graphify-out')
STEMS = ('00_brief', 'l1_temporal', 'l2_concurrency', 'l3_driver', 'l4_typesystem',
         'l5_archive', 'l6_contracts', 'l7_precedent',
         'council_contradiction', 'council_commitments', 'council_feasibility', 'council_redteam')


def split_stem(node_id):
    for s in sorted(STEMS, key=len, reverse=True):
        if node_id.startswith(s + '_'):
            return s, node_id[len(s) + 1:]
    return None, node_id


def score(a, b):
    ta, tb = set(a.split('_')), set(b.split('_'))
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    return inter / min(len(ta), len(tb)) * (inter / max(len(ta), len(tb))) ** 0.5


data = json.loads((OUT / '.graphify_extract.json').read_text(encoding='utf-8'))
ids = {n['id'] for n in data['nodes']}
by_stem = {}
for i in ids:
    s, rest = split_stem(i)
    by_stem.setdefault(s, []).append((rest, i))

missing = set()
for e in data['edges']:
    for side in ('source', 'target'):
        if e[side] not in ids:
            missing.add(e[side])

mapping, unresolved = {}, []
for m in sorted(missing):
    s, rest = split_stem(m)
    best, best_s = None, 0.0
    for cand_rest, cand_id in by_stem.get(s, []):
        sc = score(rest, cand_rest)
        if sc > best_s:
            best, best_s = cand_id, sc
    if best and best_s >= 0.45:
        mapping[m] = (best, round(best_s, 3))
    else:
        unresolved.append((m, best, round(best_s, 3)))

print('missing ids: %d | resolved: %d | unresolved: %d'
      % (len(missing), len(mapping), len(unresolved)))
print('\n-- resolved (showing 20) --')
for k, (v, sc) in sorted(mapping.items())[:20]:
    print('  %-52s -> %-52s %.2f' % (k, v, sc))
print('\n-- unresolved (dropped at build) --')
for m, b, sc in unresolved[:15]:
    print('  %-52s best=%s (%.2f)' % (m, b, sc))

rewritten = 0
for e in data['edges']:
    for side in ('source', 'target'):
        if e[side] in mapping:
            e[side] = mapping[e[side]][0]
            rewritten += 1
for h in data.get('hyperedges', []):
    h['nodes'] = [mapping.get(n, (n,))[0] for n in h.get('nodes', [])]

# Drop self-loops created by resolution, and edges still dangling.
ids2 = {n['id'] for n in data['nodes']}
before = len(data['edges'])
data['edges'] = [e for e in data['edges']
                 if e['source'] in ids2 and e['target'] in ids2 and e['source'] != e['target']]
print('\nendpoints rewritten: %d | edges %d -> %d' % (rewritten, before, len(data['edges'])))

(OUT / '.graphify_extract.json').write_text(
    json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')
