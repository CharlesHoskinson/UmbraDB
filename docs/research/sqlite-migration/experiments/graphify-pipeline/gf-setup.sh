#!/usr/bin/env bash
# Prepare the graphify corpus for the UmbraDB->SQLite research sprint and
# resolve the interpreter. Idempotent: safe to re-run as each report lands.
set -e
BASE=/root/umbradb-sqlite-research
cd "$BASE"

# Clean corpus dir: the brief plus every lane report that has landed so far.
# Scripts and graphify-out stay outside it so they are never scanned.
mkdir -p corpus
cp -f BRIEF.md corpus/00-BRIEF.md
for f in reports/*.md; do
  [ -e "$f" ] || continue
  cp -f "$f" "corpus/$(basename "$f")"
done

PYTHON=""
if command -v uv >/dev/null 2>&1; then
  _UV_PY=$(uv tool run --from graphifyy python -c "import sys; print(sys.executable)" 2>/dev/null || true)
  if [ -n "$_UV_PY" ]; then PYTHON="$_UV_PY"; fi
fi
if [ -z "$PYTHON" ]; then
  GB=$(command -v graphify 2>/dev/null || true)
  if [ -n "$GB" ]; then
    SH=$(head -1 "$GB" | tr -d '#!')
    if "$SH" -c "import graphify" 2>/dev/null; then PYTHON="$SH"; fi
  fi
fi
if [ -z "$PYTHON" ]; then PYTHON=python3; fi
if ! "$PYTHON" -c "import graphify" 2>/dev/null; then
  echo "graphify import FAILED for $PYTHON"
  exit 1
fi

mkdir -p graphify-out
"$PYTHON" -c "import sys; open('graphify-out/.graphify_python','w',encoding='utf-8').write(sys.executable)"
echo "$BASE/corpus" > graphify-out/.graphify_root

echo "PYTHON=$PYTHON"
echo "CORPUS:"
ls -1 corpus/
