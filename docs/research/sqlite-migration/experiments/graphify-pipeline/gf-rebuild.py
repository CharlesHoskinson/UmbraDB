"""Build/cluster/export from the ALREADY-MERGED, already-resolved extraction.

Deliberately does not re-merge the chunk files: gf-resolve.py has rewritten
.graphify_extract.json in place and re-merging would discard that work.
"""
import json
from pathlib import Path

from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.analyze import god_nodes, surprising_connections, suggest_questions
from graphify.report import generate
from graphify.export import to_json
from graphify.diagnostics import diagnose_extraction, format_diagnostic_report

BASE = Path('/root/umbradb-sqlite-research')
OUT = BASE / 'graphify-out'
ROOT = str(BASE / 'corpus')

extraction = json.loads((OUT / '.graphify_extract.json').read_text(encoding='utf-8'))
detection = json.loads((OUT / '.graphify_detect.json').read_text(encoding='utf-8'))

summary = diagnose_extraction(extraction, directed=False, root=ROOT)
flags = [f'{summary[k]} {label}' for k, label in (
    ('dangling_endpoint_edges', 'dangling-endpoint edges'),
    ('missing_endpoint_edges', 'missing-endpoint edges'),
    ('self_loop_edges', 'self-loop edges'),
    ('undirected_same_endpoint_collapsed_edges', 'collapsed edges'),
) if summary.get(k, 0)]
print('GRAPH HEALTH WARNING: ' + '; '.join(flags) if flags else 'Graph health: OK')

G = build_from_json(extraction, root=ROOT, directed=False)
if G.number_of_nodes() == 0:
    raise SystemExit('ERROR: Graph is empty')

communities = cluster(G)
cohesion = score_all(G, communities)
gods = god_nodes(G)
surprises = surprising_connections(G, communities)
labels = {cid: 'Community ' + str(cid) for cid in communities}
questions = suggest_questions(G, communities, labels)

if not to_json(G, communities, str(OUT / 'graph.json')):
    raise SystemExit('ERROR: refused to shrink graph.json (#479)')

report = generate(G, communities, cohesion, labels, gods, surprises, detection,
                  {'input': 0, 'output': 0}, ROOT, suggested_questions=questions)
(OUT / 'GRAPH_REPORT.md').write_text(report, encoding='utf-8')
(OUT / '.graphify_analysis.json').write_text(json.dumps({
    'communities': {str(k): v for k, v in communities.items()},
    'cohesion': {str(k): v for k, v in cohesion.items()},
    'gods': gods, 'surprises': surprises, 'questions': questions,
}, indent=2, ensure_ascii=False), encoding='utf-8')

print('Graph: %d nodes, %d edges, %d communities'
      % (G.number_of_nodes(), G.number_of_edges(), len(communities)))
singletons = sum(1 for m in communities.values() if len(m) == 1)
print('singleton communities: %d' % singletons)
for cid, members in sorted(communities.items(), key=lambda kv: -len(kv[1]))[:14]:
    print('  c%-3s %3d nodes | coh %.3f | %s'
          % (cid, len(members), cohesion.get(cid, 0.0), ', '.join(members[:6])))
