#!/usr/bin/env bash
# The only way the lead session merges a pull request (docs/agents/TASKS.md, "Merging"). It re-checks the
# policy at merge time, from main's rules, instead of trusting a status that may be stale:
#   1. the PR is open, targets main, and its head is the commit that was reviewed and tested;
#   2. `test` passed and `guardrails/policy` is green on exactly that commit;
#   3. the submission freeze (repo variable AGENT_FREEZE_AT) has not started, read now, not when CI ran;
#   4. main's classify.sh, run here on the PR's current files, finds nothing that blocks, and anything material
#      carries the owner's review label (whose actor and timing guard.sh verified for the green status);
#   5. an independent review recorded, on a line of its own, "Independent review: PASS at <full head sha>";
# then squash-merges pinned to that commit and waits for CI on main.
#
# Always run main's copy, never one from a branch (it refuses otherwise):
#   gh api repos/parammadan/countersign/contents/scripts/agents/merge.sh?ref=main --jq .content | base64 -d > /tmp/merge.sh
#   bash /tmp/merge.sh <pr-number> [--dry-run]
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
main_file() { gh api "${API}/contents/$1?ref=main" --jq .content | base64 -d; } # a file as it is on main

# 0. this script must be main's copy: a branch's merge.sh (or a local edit) could judge its own pull request
main_file scripts/agents/merge.sh > "${work}/merge.main.sh" || fail "couldn't read scripts/agents/merge.sh from main"
cmp -s "${BASH_SOURCE[0]}" "${work}/merge.main.sh" || fail "this is not main's merge.sh; run main's copy (see the header)"

# 1. the pull request
gh api "${API}/pulls/${pr}" > "${work}/pr.json"
[[ "$(jq -r .state "${work}/pr.json")" == "open" ]] || fail "#${pr} is not open"
[[ "$(jq -r .base.ref "${work}/pr.json")" == "main" ]] || fail "#${pr} targets $(jq -r .base.ref "${work}/pr.json"), not main"
sha="$(jq -r .head.sha "${work}/pr.json")"
title="$(jq -r .title "${work}/pr.json")"
ok "#${pr} \"${title}\" into main at ${sha:0:7}"

# 2. checks on exactly this commit, from GitHub Actions only
test_runs="$(gh api "${API}/commits/${sha}/check-runs?per_page=100" --jq '[.check_runs[] | select(.name == "test" and .app.slug == "github-actions")] | sort_by(.started_at) | last | .conclusion // "missing"')"
[[ "$test_runs" == "success" ]] || fail "\`test\` on ${sha:0:7} is ${test_runs}"
# the latest guardrails/policy status must be green and must come from the agent-guard workflow run for this PR
gh api "${API}/commits/${sha}/statuses?per_page=100" --jq '[.[] | select(.context == "guardrails/policy")] | first // {}' > "${work}/status.json"
[[ "$(jq -r '.state // "missing"' "${work}/status.json")" == "success" ]] || fail "\`guardrails/policy\` on ${sha:0:7} is $(jq -r '.state // "missing"' "${work}/status.json")"
[[ "$(jq -r '.creator.login // ""' "${work}/status.json")" == "github-actions[bot]" ]] || fail "\`guardrails/policy\` wasn't posted by GitHub Actions"
run_id="$(jq -r '.target_url // ""' "${work}/status.json" | grep -oE '/actions/runs/[0-9]+$' | grep -oE '[0-9]+$' || true)"
[[ -n "$run_id" ]] || fail "\`guardrails/policy\` doesn't link to its workflow run"
gh api "${API}/actions/runs/${run_id}" > "${work}/run.json"
jq -e --arg sha "$sha" --argjson pr "$pr" '.path == ".github/workflows/agent-guard.yml" and .event == "pull_request_target" and .head_sha == $sha and ([.pull_requests[].number] | index($pr)) != null' "${work}/run.json" >/dev/null \
  || fail "\`guardrails/policy\` didn't come from the agent-guard run for #${pr} at ${sha:0:7}"
ok "test and guardrails/policy (agent-guard run ${run_id}) are green on ${sha:0:7}"

# 3. the freeze, now
# only a "not found" means no freeze; any other error refuses (an outage must not look like an unset freeze)
if out="$(gh api "${API}/actions/variables/AGENT_FREEZE_AT" --jq .value 2>"${work}/freeze.err")"; then
  freeze="$out"; [[ -n "$freeze" ]] || fail "AGENT_FREEZE_AT exists but is empty"
elif grep -q "HTTP 404" "${work}/freeze.err"; then
  freeze=""
else
  fail "couldn't read AGENT_FREEZE_AT: $(head -c 200 "${work}/freeze.err")"
fi
if [[ -n "$freeze" ]]; then
  [[ "$freeze" =~ (Z|[+-][0-9]{2}:[0-9]{2})$ ]] || fail "AGENT_FREEZE_AT has no time zone: ${freeze}"
  fz="$(python3 -c 'import sys, datetime; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).timestamp()))' "$freeze")" || fail "AGENT_FREEZE_AT is not a valid time: ${freeze}"
  (( $(date -u +%s) < fz )) || fail "the submission freeze started at ${freeze}; after it, only the owner merges, with a freeze exception"
  ok "before the freeze (${freeze})"
else
  ok "no freeze configured"
fi

# 4. classify again with main's rules, on the PR as it is now
mkdir -p "${work}/guard"
for f in classify.sh critical-paths.txt routine-paths.txt; do main_file ".github/agent-guard/${f}" > "${work}/guard/${f}" || fail "couldn't read ${f} from main"; done
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
# a line of its own, naming the full head commit; quoted lines (">") don't count
gh api --paginate "${API}/issues/${pr}/comments" --jq '.[].body' | tr -d '\r' > "${work}/comments.txt"
grep -qxF "Independent review: PASS at ${sha}" "${work}/comments.txt" || fail "no independent-review line for the full head commit ${sha} on #${pr}"
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
