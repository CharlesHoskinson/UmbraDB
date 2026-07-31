import json
from pathlib import Path
from graphify.cache import check_semantic_cache

BASE = Path('/root/umbradb-sqlite-research')
OUT = BASE / 'graphify-out'
SPEC = '/root/.local/share/uv/tools/graphifyy/lib/python3.13/site-packages/graphify/skills/claude/references/extraction-spec.md'

detect = json.loads((OUT / '.graphify_detect.json').read_text(encoding='utf-8'))
all_files = [f for cat in ('document', 'paper', 'image') for f in detect['files'].get(cat, [])]

cached_nodes, cached_edges, cached_hyperedges, uncached = check_semantic_cache(
    all_files, root=str(BASE / 'corpus'), prompt_file=SPEC
)

if cached_nodes or cached_edges or cached_hyperedges:
    (OUT / '.graphify_cached.json').write_text(
        json.dumps({'nodes': cached_nodes, 'edges': cached_edges, 'hyperedges': cached_hyperedges},
                   ensure_ascii=False), encoding='utf-8')
else:
    (OUT / '.graphify_cached.json').unlink(missing_ok=True)

(OUT / '.graphify_uncached.txt').write_text('\n'.join(uncached), encoding='utf-8')
print('Cache: %d hit, %d need extraction' % (len(all_files) - len(uncached), len(uncached)))
for u in uncached:
    print('  UNCACHED', u)
