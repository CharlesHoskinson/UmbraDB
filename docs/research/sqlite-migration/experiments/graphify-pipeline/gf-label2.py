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
    1:  'Driver Shim, Types and Worker Boundary',
    2:  'Lease, Cancellation and Release Gates',
    3:  'Postgres Features and Formal Laws',
    4:  'Frozen Surface, SemVer and Driver Pinning',
    5:  'DDL and Forward-Only Migration Limits',
    6:  'T5 Enforcement and Busy Semantics',
    7:  'Type Parity and Query Constructs',
    8:  'Measurement Validity and Tag Sequencing',
    9:  'Error Catalog, Clock and Gates',
    10: 'The Break Ledger and SemVer Ruling',
    11: 'Driver Decoding and Collation Hazards',
    12: 'Schema Emulation and File Layout',
    13: 'Backup, Restore and Blob I/O',
    14: 'Red Team: Broken Claims and Survivors',
    15: 'postgres.js Idiom and Shim Port',
    16: 'Chain Archive Struck From Scope',
    17: 'JSONB Document Storage',
    18: 'Sprint Trap: Dependency Install',
    19: 'Sprint Trap: WSL Path Resolution',
    20: 'Ruling: Additive-Only Union Widening',
    21: 'Ruling: CONTRACT Retry Clause',
    22: 'Ruling: EVIDENCE.md Is Sunk Cost',
    23: 'Ruling: Required-Tests Manifest Interlock',
    24: 'Ruling: locking_mode=EXCLUSIVE Closed',
    25: 'Gap: Out-of-Cache Behaviour Unmeasured',
    26: 'Loss: idle_in_transaction Backstop',
    27: 'Loss: External Observability',
    28: 'Regression: JSON Write-Time Validation',
    29: 'Survived Attack: Key-Reuse Forgery',
    30: 'Finding: Out-of-Cache Onset at 2.4 GB',
    31: 'Finding: synchronous Dominates Throughput',
    32: 'Gap: Windows Behaviour Unowned',
    33: 'Cost: Worker Lengthens Write Lock',
}

questions = suggest_questions(G, communities, labels)
report = generate(G, communities, cohesion, labels, analysis['gods'], analysis['surprises'],
                  detection, {'input': 0, 'output': 0}, ROOT, suggested_questions=questions)
(OUT / 'GRAPH_REPORT.md').write_text(report, encoding='utf-8')
(OUT / '.graphify_labels.json').write_text(
    json.dumps({str(k): v for k, v in labels.items()}, ensure_ascii=False), encoding='utf-8')
print('Report updated with %d community labels' % len(labels))
