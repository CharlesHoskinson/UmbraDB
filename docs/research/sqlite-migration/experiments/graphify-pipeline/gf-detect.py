import json
from pathlib import Path
from graphify.detect import detect

result = detect(Path('/root/umbradb-sqlite-research/corpus'))
Path('/root/umbradb-sqlite-research/graphify-out/.graphify_detect.json').write_text(
    json.dumps(result, ensure_ascii=False), encoding='utf-8'
)
counts = {k: len(v) for k, v in result.get('files', {}).items() if v}
print('total_files:', result.get('total_files'))
print('total_words:', result.get('total_words'))
print('by_type:', counts)
print('skipped_sensitive:', result.get('skipped_sensitive'))
