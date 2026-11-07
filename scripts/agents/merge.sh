#!/usr/bin/env bash
# The only way the lead session merges a pull request (docs/agents/TASKS.md, "Merging"). It re-checks the
# policy at merge time, from main's rules, instead of trusting a status that may be stale:
#   1. the PR is open, targets main, and its head is the commit that was reviewed and tested;
#   2. `test` passed and `guardrails/policy` is green on exactly that commit;
#   3. the submission freeze (repo variable AGENT_FREEZE_AT) has not started, read now, not when CI ran;
#   4. main's classify.sh, run here on the PR's current files, finds nothing that blocks, and anything material
#      carries the owner's review label (whose actor and timing guard.sh verified for the green status);
#   5. an independent review recorded "Independent review: PASS at <head sha>" on the PR;
# then squash-merges pinned to that commit and waits for CI on main.
#
#   scripts/agents/merge.sh <pr-number> [--dry-run]
# Never merges after the freeze, never bypasses a red check, never applies labels.
set -euo pipefail
pr="${1:?usage: merge.sh <pr-number> [--dry-run]}"
dry="${2:-}"
REPO="parammadan/countersign"
API="repos/${REPO}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail() { echo "REFUSED: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

# 1. the pull request
gh api "${API}/pulls/${pr}" > "${work}/pr.json"
[[ "$(jq -r .state "${work}/pr.json")" == "open" ]] || fail "#${pr} is not open"
[[ "$(jq -r .base.ref "${work}/pr.json")" == "main" ]] || fail "#${pr} targets $(jq -r .base.ref "${work}/pr.json"), not main"
sha="$(jq -r .head.sha "${work}/pr.json")"
title="$(jq -r .title "${work}/pr.json")"
ok "#${pr} \"${title}\" into main at ${sha:0:7}"

# 2. checks on exactly this commit
test_runs="$(gh api "${API}/commits/${sha}/check-runs?per_page=100" --jq '[.check_runs[] | select(.name == "test")] | sort_by(.started_at) | last | .conclusion // "missing"')"
[[ "$test_runs" == "success" ]] || fail "\`test\` on ${sha:0:7} is ${test_runs}"
policy="$(gh api "${API}/commits/${sha}/status" --jq '[.statuses[] | select(.context == "guardrails/policy")] | first | .state // "missing"')"
[[ "$policy" == "success" ]] || fail "\`guardrails/policy\` on ${sha:0:7} is ${policy}"
ok "test and guardrails/policy are green on ${sha:0:7}"

# 3. the freeze, now
freeze="$(gh variable get AGENT_FREEZE_AT -R "$REPO" 2>/dev/null || true)"
if [[ -n "$freeze" ]]; then
  [[ "$freeze" =~ (Z|[+-][0-9]{2}:[0-9]{2})$ ]] || fail "AGENT_FREEZE_AT has no time zone: ${freeze}"
  fz="$(python3 -c 'import sys, datetime; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).timestamp()))' "$freeze")" || fail "AGENT_FREEZE_AT is not a valid time: ${freeze}"
  (( $(date -u +%s) < fz )) || fail "the submission freeze started at ${freeze}; after it, only the owner merges, with a freeze exception"
  ok "before the freeze (${freeze})"
else
  ok "no freeze configured"
fi

# 4. classify again with main's rules, on the PR as it is now
git fetch -q origin main
mkdir -p "${work}/guard"
for f in classify.sh critical-paths.txt routine-paths.txt; do git show "origin/main:.github/agent-guard/${f}" > "${work}/guard/${f}"; done
gh api --paginate "${API}/pulls/${pr}/files" --jq '.[] | [.filename, (.previous_filename // ""), .status, (.deletions | tostring), ((.patch != null) | tostring)] | @tsv' > "${work}/files.tsv"
gh api --paginate "${API}/pulls/${pr}/files" --jq '.[] | select(.patch != null) | .filename as $f | .patch | split("\n")[] | select(startswith("+")) | $f + "\t" + .[1:]' > "${work}/added.tsv"
[[ "$(wc -l < "${work}/files.tsv" | tr -d ' ')" == "$(jq -r .changed_files "${work}/pr.json")" ]] || fail "not every changed file could be listed"
bash "${work}/guard/classify.sh" "${work}/files.tsv" "${work}/added.tsv" > "${work}/risk.tsv"
if grep -q '^BLOCK' "${work}/risk.tsv"; then fail "$(grep '^BLOCK' "${work}/risk.tsv" | cut -f2-)"; fi
if grep -q '^MATERIAL' "${work}/risk.tsv"; then
  jq -e '[.labels[].name] | index("owner-approved-paths")' "${work}/pr.json" >/dev/null \
    || fail "material change without the owner's review: $(cut -f2- "${work}/risk.tsv" | tr '\n' ' ')"
  ok "material change, owner-reviewed (label present; guard.sh verified who applied it and when)"
else
  ok "routine change"
fi

# 5. an independent review of this exact commit
gh api --paginate "${API}/issues/${pr}/comments" --jq '.[].body' > "${work}/comments.txt"
grep -qiE "independent review: pass at ${sha:0:7}" "${work}/comments.txt" || fail "no \"Independent review: PASS at ${sha:0:7}\" recorded on #${pr}"
ok "independent review recorded for ${sha:0:7}"

if [[ "$dry" == "--dry-run" ]]; then echo "DRY RUN: would squash-merge #${pr} at ${sha:0:7}"; exit 0; fi

# merge, pinned to the reviewed commit, then confirm main stays green
gh pr merge "$pr" -R "$REPO" --squash --match-head-commit "$sha" --subject "${title} (#${pr})" --body ""
merged="$(gh api "${API}/pulls/${pr}" --jq .merge_commit_sha)"
ok "merged as ${merged:0:7}; waiting for CI on main"
for _ in $(seq 1 60); do
  c="$(gh api "${API}/commits/${merged}/check-runs" --jq '[.check_runs[] | select(.name == "test")] | last | (.status + "/" + (.conclusion // ""))' 2>/dev/null || echo "")"
  [[ "$c" == completed/* ]] && break
  sleep 20
done
[[ "$c" == "completed/success" ]] || fail "CI on main after merging #${pr} is ${c:-unknown}: stop and fix main before merging anything else"
ok "main is green at ${merged:0:7}"
