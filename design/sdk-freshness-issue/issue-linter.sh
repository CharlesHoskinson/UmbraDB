#!/usr/bin/env bash
# issue-linter.sh — mechanical pre-flight lint for a draft GitHub issue.
#
# Usage:
#   ./issue-linter.sh <issue.md>
#
# What it does: greps a markdown draft for patterns associated with weak
# issues (see ISSUE-CHECKLIST.md for the human-judgment version of the same
# rules). It is dependency-light (bash + grep + sed + wc, no python, no
# external packages) and intentionally dumb: it flags *patterns*, not
# correctness. A hit is a prompt to look at that line, not a verdict.
#
# Exit codes:
#   0 = no ERRORs (WARNs may still be present — read the report)
#   1 = at least one ERROR
#   2 = usage / file-not-found problem
#
# ERROR vs WARN policy:
#   ERROR — the five structural load-bearing pieces of a good issue
#           (title, version/context, a concrete location citation, an impact
#           statement, a suggested-fix section) and self-referential leakage
#           of internal project/process names, which should never ship in a
#           public issue.
#   WARN  — everything pattern-based that needs human judgment to resolve:
#           AI-slop tells (hedging filler, rhetorical counting, em-dash
#           overuse, listicle-of-listicles), over-claimed severity language,
#           and "more than one H1" (possible multi-issue bundling).
#
# A WARN is not proof of a problem — e.g. this linter will flag the word
# "vulnerability" even inside the sentence "this is not a vulnerability
# report," because it does not parse negation. Read the flagged line.

set -uo pipefail

FILE="${1:-}"
if [ -z "$FILE" ]; then
  echo "usage: $(basename "$0") <path-to-issue.md>" >&2
  exit 2
fi
if [ ! -f "$FILE" ]; then
  echo "error: file not found: $FILE" >&2
  exit 2
fi

ERRORS=0
WARNINGS=0

hr() { printf '%.0s-' $(seq 1 70); echo; }
section() { echo; echo "== $1 =="; }
ok()   { echo "  [OK]    $1"; }
info() { echo "          $1"; }
err()  { ERRORS=$((ERRORS + 1)); echo "  [ERROR] $1"; }
warn() { WARNINGS=$((WARNINGS + 1)); echo "  [WARN]  $1"; }

# Print up to N matched lines, each prefixed for readability.
show_matches() {
  local matches="$1" limit="${2:-5}"
  printf '%s\n' "$matches" | head -n "$limit" | sed 's/^/          /'
  local total
  total=$(printf '%s\n' "$matches" | grep -c '^')
  if [ "$total" -gt "$limit" ]; then
    info "... and $((total - limit)) more"
  fi
}

echo "issue-linter.sh — linting: $FILE"
hr

# ---------------------------------------------------------------------------
# (c) STRUCTURE — hard requirements
# ---------------------------------------------------------------------------
section "Structure"

# Title: first non-blank line must be a markdown H1.
first_nonblank=$(grep -n '[^[:space:]]' "$FILE" | head -1)
first_lineno=${first_nonblank%%:*}
first_text=${first_nonblank#*:}
if printf '%s' "$first_text" | grep -qE '^# .+'; then
  ok "title present (line ${first_lineno:-?}): ${first_text#\# }"
else
  err "first non-blank line is not a '# Title' (found: '${first_text:-<empty file>}')"
fi

# More than one H1 heading -> possible multi-issue bundling (soft check).
h1_count=$(grep -cE '^# ' "$FILE")
if [ "$h1_count" -gt 1 ]; then
  warn "found $h1_count top-level '# ' headings — one issue per report? (Mozilla: \"open a new bug report for each issue\")"
fi

# Context / version: "version" keyword, semver, or a commit hash.
matches=$(grep -nEi '(\bversion\b|\bv[0-9]+\.[0-9]+(\.[0-9]+)?\b|@[0-9a-f]{7,40}\b|\b[0-9a-f]{7,40}\b)' "$FILE")
if [ -n "$matches" ]; then
  ok "version/context reference found"
  show_matches "$matches" 3
else
  err "no version/commit/context marker found (expected e.g. 'Version:', 'v1.2.3', or a commit hash)"
fi

# Concrete location: file:line reference or a URL citation.
loc_matches=$(grep -nE '[A-Za-z0-9_./-]+\.(rs|ts|tsx|js|jsx|py|go|c|cc|cpp|h|hpp|java|rb|md|toml|ya?ml):[0-9]+' "$FILE")
url_matches=$(grep -nE 'https?://' "$FILE")
combined=$(printf '%s\n%s' "$loc_matches" "$url_matches" | grep -v '^$')
if [ -n "$combined" ]; then
  ok "concrete location/citation found (file:line and/or URL)"
  show_matches "$combined" 3
else
  err "no concrete file:line reference or URL citation found"
fi

# Impact statement.
matches=$(grep -nEi '^#+ .*impact|[^a-z]impact([^a-z]|$)' "$FILE")
if [ -n "$matches" ]; then
  ok "impact statement present"
  show_matches "$matches" 3
else
  err "no 'Impact' section / impact statement found"
fi

# Suggested fix / direction.
matches=$(grep -nEi '^#+ .*(suggest|propos|recommend)|suggested (fix|hardening|direction)|proposed (fix|direction)|recommendation' "$FILE")
if [ -n "$matches" ]; then
  ok "suggested fix / direction present"
  show_matches "$matches" 3
else
  err "no suggested-fix / proposed-direction section found"
fi

# ---------------------------------------------------------------------------
# (b) SELF-REFERENTIAL LEAKAGE — hard requirement (never belongs in a public issue)
# ---------------------------------------------------------------------------
section "Self-referential leakage"

leak_primary='UmbraDB|our council|our design|\bsprint\b|we investigated|our project'
matches=$(grep -nEi "$leak_primary" "$FILE")
if [ -n "$matches" ]; then
  err "internal project/process references found — strip before filing publicly"
  show_matches "$matches" 10
else
  ok "no internal project/process references found"
fi

leak_extended='our team|our repo(sitory)?|our codebase|internal (doc|design|spec|slack|wiki|ticket)'
matches=$(grep -nEi "$leak_extended" "$FILE")
if [ -n "$matches" ]; then
  warn "possible additional internal references (extended list) — verify these are not leakage"
  show_matches "$matches" 10
else
  ok "no extended-list internal references found"
fi

# ---------------------------------------------------------------------------
# (a) AI-SLOP TELLS — soft requirement
# ---------------------------------------------------------------------------
section "AI-slop tells"

# Rhetorical counting / enumeration.
count_re='there (are|is) (at least )?[0-9]+|there are (several|many|numerous|multiple|various)|\b(one|two|three|four|five|six|seven|several|multiple|numerous|various) (key |main |primary )?(reasons|ways|factors|considerations|steps|things|issues|points|approaches)\b'
matches=$(grep -nEi "$count_re" "$FILE")
if [ -n "$matches" ]; then
  warn "rhetorical counting/enumeration ('there are N', 'three reasons', 'several ways')"
  show_matches "$matches" 8
else
  ok "no rhetorical counting/enumeration found"
fi

# Hedging filler / AI-tell vocabulary.
hedge_re="it.s worth noting|it is worth noting|it.s important to (note|remember)|it is important to (note|remember)|worth noting that|\bdelv(e|es|ed|ing)\b|\bleverag(e|es|ed|ing)\b|\brobust\b|\bseamless(ly)?\b|\bcutting-edge\b|in today.s (world|digital age)|\bat its core\b|\bmoreover\b|\bfurthermore\b|\bin conclusion\b|\bunderscore(s|d)?\b|\bfoster(s|ed|ing)?\b|paradigm shift|\bmyriad\b|\bplethora\b|\btapestry\b|\bgame-changer\b|testament to|\belevate(s|d)?\b|\bstreamline(s|d)?\b|\bsynergy\b|navigate the complex"
matches=$(grep -nEi "$hedge_re" "$FILE")
if [ -n "$matches" ]; then
  warn "hedging filler / AI-tell vocabulary found"
  show_matches "$matches" 10
else
  ok "no hedging filler / AI-tell vocabulary found"
fi

# Em-dash overuse.
em_count=$(grep -o '—' "$FILE" | wc -l | tr -d ' ')
em_threshold=6
if [ "$em_count" -gt "$em_threshold" ]; then
  warn "em dash used $em_count times (threshold >$em_threshold) — check for tic-like overuse"
else
  ok "em-dash count: $em_count (within threshold of $em_threshold)"
fi

# Listicle-of-listicles: bolded-header bullet pattern, e.g. "- **Foo**: bar".
bullet_re='^[[:space:]]*[-*][[:space:]]+\*\*[^*]+\*\*:'
bullet_count=$(grep -cE "$bullet_re" "$FILE")
bullet_threshold=3
if [ "$bullet_count" -ge "$bullet_threshold" ]; then
  warn "found $bullet_count bold-header bullets ('- **X**: ...') — possible listicle-of-listicles"
  show_matches "$(grep -nE "$bullet_re" "$FILE")" 6
else
  ok "bold-header bullet count: $bullet_count (below listicle threshold of $bullet_threshold)"
fi

# ---------------------------------------------------------------------------
# (d) OVER-CLAIM — soft requirement (context-dependent; negation not parsed)
# ---------------------------------------------------------------------------
section "Over-claim (hardening issues should not need these)"

overclaim_re='\bvulnerabilit(y|ies)\b|\bexploit(s|ed|ing)?\b|\bcritical\b|fund(s)? loss|loss of funds|\bCVE-[0-9]|remote code execution|\bRCE\b'
matches=$(grep -nEi "$overclaim_re" "$FILE")
if [ -n "$matches" ]; then
  warn "severity-inflating language found — verify each hit is not an unsupported claim (negated mentions like 'not a vulnerability' are expected and fine)"
  show_matches "$matches" 10
else
  ok "no severity-inflating language found"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
hr
echo "SUMMARY: $ERRORS error(s), $WARNINGS warning(s)"
if [ "$ERRORS" -gt 0 ]; then
  echo "RESULT: FAIL"
  exit 1
else
  echo "RESULT: PASS (review warnings above before filing)"
  exit 0
fi
