import json, glob
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

# --- Part B3: merge chunk files -------------------------------------------
chunks = sorted(glob.glob(str(OUT / '.graphify_chunk_*.json')))
nodes, edges, hyper = [], [], []
for c in chunks:
    d = json.loads(Path(c).read_text(encoding='utf-8'))
    nodes += d.get('nodes', [])
    edges += d.get('edges', [])
    hyper += d.get('hyperedges', [])
print('chunks merged: %d -> %d raw nodes, %d edges, %d hyperedges'
      % (len(chunks), len(nodes), len(edges), len(hyper)))

# --- Part C: no code files, so AST is empty; dedupe by id ------------------
seen, deduped = set(), []
for n in nodes:
    if n['id'] not in seen:
        seen.add(n['id'])
        deduped.append(n)
print('after dedupe: %d nodes (%d duplicate ids collapsed)' % (len(deduped), len(nodes) - len(deduped)))

extraction = {
    'nodes': deduped, 'edges': edges, 'hyperedges': hyper,
    'input_tokens': 0, 'output_tokens': 0,
}
(OUT / '.graphify_extract.json').write_text(
    json.dumps(extraction, indent=2, ensure_ascii=False), encoding='utf-8')

# --- Step 4.5: health check (read-only) -----------------------------------
summary = diagnose_extraction(extraction, directed=False, root=ROOT)
print(format_diagnostic_report(summary))
flags = [f'{summary[k]} {label}' for k, label in (
    ('dangling_endpoint_edges', 'dangling-endpoint edges'),
    ('missing_endpoint_edges', 'missing-endpoint edges'),
    ('self_loop_edges', 'self-loop edges'),
    ('undirected_same_endpoint_collapsed_edges', 'collapsed edges'),
) if summary.get(k, 0)]
print('GRAPH HEALTH WARNING: ' + '; '.join(flags) if flags else 'Graph health: OK')

# --- Step 4: build, cluster, analyze, export ------------------------------
G = build_from_json(extraction, root=ROOT, directed=False)
if G.number_of_nodes() == 0:
    raise SystemExit('ERROR: Graph is empty')

communities = cluster(G)
cohesion = score_all(G, communities)
gods = god_nodes(G)
surprises = surprising_connections(G, communities)
labels = {cid: 'Community ' + str(cid) for cid in communities}
questions = suggest_questions(G, communities, labels)

wrote = to_json(G, communities, str(OUT / 'graph.json'))
if not wrote:
    raise SystemExit('ERROR: refused to shrink graph.json (#479)')

detection = json.loads((OUT / '.graphify_detect.json').read_text(encoding='utf-8'))
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
for cid, members in sorted(communities.items(), key=lambda kv: -len(kv[1])):
    print('  community %s: %d nodes | cohesion %.3f | %s'
          % (cid, len(members), cohesion.get(cid, 0.0), ', '.join(members[:8])))
