#!/usr/bin/env bash
# Risk classification of a pull request's changes. Used by guard.sh (CI) and scripts/agents/merge.sh (at
# merge time), tested by test/guard-policy.test.ts. Default deny: a change is routine only when every file
# is on routine-paths.txt, none is on critical-paths.txt, and no content rule fires.
#
#   classify.sh <files.tsv> <added.tsv>
#     files.tsv: filename <TAB> previous_filename <TAB> status <TAB> deletions <TAB> has_patch(true|false)
#     added.tsv: filename <TAB> added line
#
# Prints one line per finding, nothing for a routine change:
#   MATERIAL <TAB> reason   needs the owner's review before merging
#   BLOCK    <TAB> reason   never merges as is
# Reads its inputs as data only; nothing from the pull request is executed.
set -euo pipefail
files="$1" added="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
grep -vE '^\s*(#|$)' "${HERE}/critical-paths.txt" > "${tmp}/critical"
grep -vE '^\s*(#|$)' "${HERE}/routine-paths.txt" > "${tmp}/routine"
list() { sort -u | tr '\n' ' ' | sed 's/ $//'; }
tests_re='^(test/[^/]+\.test\.ts|e2e/[^/]+\.spec\.ts)$'
code_re='\.(ts|tsx|js|jsx|mjs|cjs)$'

# 1. paths: every name a file has (a rename counts under its old and its new name)
cut -f1,2 "$files" | tr '\t' '\n' | grep -v '^$' | sort -u > "${tmp}/names"
crit="$(grep -Ef "${tmp}/critical" "${tmp}/names" | list || true)"
[[ -n "$crit" ]] && printf 'MATERIAL\tChanges material paths (signing, auth, data, secrets, infrastructure or the checks themselves): %s\n' "$crit"
unknown="$(grep -vEf "${tmp}/critical" "${tmp}/names" | grep -vEf "${tmp}/routine" | list || true)"
[[ -n "$unknown" ]] && printf 'MATERIAL\tChanges files outside the routine list (default deny): %s\n' "$unknown"

# 2. diffs that can't be inspected (GitHub omits patches for binary and very large files): only binary
# fixtures, sample PDFs, images and visual baselines may have no patch
blind="$(awk -F'\t' '$5 == "false" && $3 != "removed" {print $1}' "$files" \
  | grep -vE '^(fixtures/[a-z0-9-]+/.+\.(pdf|docx)|public/samples/.+\.pdf|public/.+\.(png|ico|jpg|webp)|e2e/visual\.spec\.ts-snapshots/.+\.png)$' | list || true)"
[[ -n "$blind" ]] && printf 'MATERIAL\tDiff not shown by GitHub, so it could not be inspected: %s\n' "$blind"

# 3. weakening the checks
#    any deletion in an existing test file, or removing/renaming one (new test files are routine)
weakened="$(awk -F'\t' '($3 == "modified" || $3 == "changed") && $4 > 0 {print $1} $3 == "removed" {print $1} $3 == "renamed" {print $2}' "$files" \
  | grep -E "$tests_re" | list || true)"
[[ -n "$weakened" ]] && printf 'MATERIAL\tChanges or removes existing test code: %s\n' "$weakened"
RE="$tests_re" awk -F'\t' '$1 ~ ENVIRON["RE"]' "$added" > "${tmp}/test-lines"
#    skipping, expecting failure, or deferring a test, in any form
skips="$(grep -E '\.(skip|fixme|fail|fails|todo|skipIf|runIf)([^A-Za-z0-9_]|$)|\b(xit|xdescribe|xtest)[[:space:]]*\(' "${tmp}/test-lines" | cut -f1 | list || true)"
[[ -n "$skips" ]] && printf 'MATERIAL\tSkips, defers or inverts tests: %s\n' "$skips"
#    focusing tests silently drops the rest of the suite
only="$(grep -E '\.only([^A-Za-z0-9_]|$)|\[[[:space:]]*["'"'"'`]only["'"'"'`][[:space:]]*\]|\b(fit|fdescribe|ftest)[[:space:]]*\(' "${tmp}/test-lines" | cut -f1 | list || true)"
[[ -n "$only" ]] && printf 'BLOCK\tFocuses tests (.only or similar), which silently skips the rest of the suite: %s\n' "$only"

# 4. content of code that is not a test: server actions, raw SQL, new imports of data/auth/signing modules
RE="$tests_re" CODE="$code_re" awk -F'\t' '$1 !~ ENVIRON["RE"] && $1 ~ ENVIRON["CODE"]' "$added" > "${tmp}/code-lines"
srv="$(grep -E '["'"'"']use server["'"'"']' "${tmp}/code-lines" | cut -f1 | list || true)"
[[ -n "$srv" ]] && printf 'MATERIAL\tAdds server actions ("use server"): %s\n' "$srv"
sql="$(grep -E '\b(SELECT|INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH|VACUUM)\b' "${tmp}/code-lines" | cut -f1 | list || true)"
[[ -n "$sql" ]] && printf 'MATERIAL\tAdds SQL (data access or writes) in: %s\n' "$sql"
mods='(db|audit|auth|http|files|templates|signer|secret|storage|util|emailverify|email|webhooks|library|dashboard|csv|consent|ratelimit|ssrf|worker|convert|fields|detect|schemas|filepage|paths|errors|pdf(/[a-z-]+)?)'
imp="$(grep -E "(from|import|require)[[:space:]]*\(?[[:space:]]*[\"'](@/lib/|(\.\./)+lib/|\./)${mods}[\"']" "${tmp}/code-lines" | cut -f1 | list || true)"
[[ -n "$imp" ]] && printf 'MATERIAL\tAdds imports of data, auth or signing modules in: %s\n' "$imp"
exit 0
