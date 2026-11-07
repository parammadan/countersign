#!/usr/bin/env bash
# Risk classification of a pull request's changes, used by guard.sh and tested by test/guard-policy.test.ts.
#
#   classify.sh <files.tsv> <added.tsv>
#     files.tsv: filename <TAB> previous_filename <TAB> status   (status as GitHub reports it: added, removed, …)
#     added.tsv: filename <TAB> added line                       (each line the PR adds)
#
# Prints one line per finding, nothing for a routine change:
#   MATERIAL <TAB> reason   needs the owner's review before merging
#   BLOCK    <TAB> reason   never merges as is
# Reads its inputs as data only; nothing from the pull request is executed.
set -euo pipefail
files="$1" added="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
re="$(mktemp)"
trap 'rm -f "$re"' EXIT
grep -vE '^\s*(#|$)' "${HERE}/critical-paths.txt" > "$re"

# 1. material paths (a rename counts under both its old and its new name)
hits="$(cut -f1,2 "$files" | tr '\t' '\n' | grep -v '^$' | grep -Ef "$re" | sort -u | tr '\n' ' ' || true)"
[[ -n "$hits" ]] && printf 'MATERIAL\tChanges material paths (signing, auth, data, secrets, infrastructure or the checks themselves): %s\n' "${hits% }"

# 2. production data: writes and schema changes, wherever they are added
data="$(grep -iE '\b(INSERT[[:space:]]+(OR[[:space:]]+[A-Z]+[[:space:]]+)?INTO|UPDATE[[:space:]]+[A-Za-z_]+[[:space:]]+SET|DELETE[[:space:]]+FROM|ALTER[[:space:]]+TABLE|CREATE[[:space:]]+(TABLE|INDEX|UNIQUE)|DROP[[:space:]]+(TABLE|INDEX|COLUMN))\b' "$added" \
  | cut -f1 | grep -vE '^(test/|e2e/)' | sort -u | tr '\n' ' ' || true)"
[[ -n "$data" ]] && printf 'MATERIAL\tAdds database writes or schema changes outside the tests: %s\n' "${data% }"

# 3. weakening the checks: skipped or deleted tests need review; a focused test (.only) never merges
tests_re='^(test/.*\.test\.ts|e2e/.*\.spec\.ts)$'
# unconditional only: a skipped test definition (test.skip("title", …)) or a bare test.skip(); a conditional
# skip with a reason (test.skip(!!process.env.X, "why")) is environment gating and still runs in CI
skips="$(grep -E '^(test/|e2e/)' "$added" | grep -E '\b(test|it|describe)(\.describe)?\.(skip|fixme)\([[:space:]]*(["'"'"'`]|\))|\b(xit|xdescribe)\(' | cut -f1 | sort -u | tr '\n' ' ' || true)"
[[ -n "$skips" ]] && printf 'MATERIAL\tAdds skipped tests: %s\n' "${skips% }"
removed="$(awk -F'\t' '$3 == "removed" {print $1} $3 == "renamed" {print $2}' "$files" | grep -E "$tests_re" | sort -u | tr '\n' ' ' || true)"
[[ -n "$removed" ]] && printf 'MATERIAL\tRemoves or renames test files: %s\n' "${removed% }"
only="$(grep -E '^(test/|e2e/)' "$added" | grep -E '\b(test|it|describe)\.only\(' | cut -f1 | sort -u | tr '\n' ' ' || true)"
[[ -n "$only" ]] && printf 'BLOCK\tFocuses tests with .only, which silently skips the rest of the suite: %s\n' "${only% }"
exit 0
