import json
from pathlib import Path

from graphify.build import build_from_json
from graphify.analyze import suggest_questions
from graphify.report import generate

BASE = Path('/root/umbradb-sqlite-research')
OUT = BASE / 'graphify-out'
ROOT = str(BASE / 'corpus')

extraction = json.loads((OUT / '.graphify_extract.json').read_text(encoding='utf-8'))
detection = json.loads((OUT / '.graphify_detect.json').read_text(encoding='utf-8'))
analysis = json.loads((OUT / '.graphify_analysis.json').read_text(encoding='utf-8'))

G = build_from_json(extraction, root=ROOT, directed=False)
communities = {int(k): v for k, v in analysis['communities'].items()}
cohesion = {int(k): v for k, v in analysis['cohesion'].items()}

labels = {
    0:  'Cryptocurrency Storage Precedent',
    1:  'Postgres Features and Formal Laws',
    2:  'Lease, Cancellation and Release Gates',
    3:  'SQLite Abort and Busy Semantics',
    4:  'DDL and Forward-Only Migration Limits',
    5:  'Storage Layout and Space Reclamation',
    6:  'Type Affinity and Driver Decoding',
    7:  'Schema Emulation Without CREATE SCHEMA',
    8:  'Frozen Surface and SemVer Policy',
    9:  'T5 Non-Overlap Enforcement',
    10: 'Error Catalog and Clock Regression',
    11: 'Event Log and Temporal Laws',
    12: 'Identifier Array Containment Search',
    13: 'Transaction Identity Guard',
    14: 'Clock Resolution and Well-Formedness',
    15: 'Formal Refinement Bridge',
    16: 'Encryption at Rest',
    17: 'Structural Gap-Freedom',
    18: 'Alternative Embedded Engines',
    19: 'Retryability Semantics',
    20: 'JSONB Document Storage',
    21: 'Sprint Trap: Dependency Install',
    22: 'Sprint Trap: WSL Path Resolution',
}

questions = suggest_questions(G, communities, labels)
report = generate(G, communities, cohesion, labels, analysis['gods'], analysis['surprises'],
                 detection, {'input': 0, 'output': 0}, ROOT, suggested_questions=questions)
(OUT / 'GRAPH_REPORT.md').write_text(report, encoding='utf-8')
(OUT / '.graphify_labels.json').write_text(
    json.dumps({str(k): v for k, v in labels.items()}, ensure_ascii=False), encoding='utf-8')
print('Report updated with %d community labels' % len(labels))
