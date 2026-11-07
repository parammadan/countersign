#!/usr/bin/env bash
# Repository policy check for every pull request, run by .github/workflows/agent-guard.yml.
#
# Runs from the BASE branch under pull_request_target: it never checks out or executes the pull request's
# code, and reads the PR only through the GitHub API. Everything from the PR (branch name, titles, file
# names, patches, commit messages) is treated as untrusted data: passed through env/files, never evaluated.
#
# Fails the `guardrails/policy` commit status when a PR:
#   1. makes a material change without the owner's review label, or focuses tests (classify.sh, default deny:
#      critical-paths.txt, anything off routine-paths.txt, server actions, SQL, new imports of data/auth/signing
#      modules, changed or skipped tests, diffs GitHub doesn't show). Routine changes need no label: they merge
#      through scripts/agents/merge.sh, which re-checks everything at merge time.
#   2. carries AI attribution: co-author or session trailers, "Generated with/by Claude" lines in commits or the
#      PR description (the PR template's own checklist lines are ignored), or commits authored by Claude,
#   3. adds secret-looking values or secret/data files,
#   4. adds real-looking email addresses (test data must use example.com / .test / .invalid),
#   5. arrives after the submission freeze (repo variable AGENT_FREEZE_AT) without a freeze exception. While
#      AGENT_FREEZE_AT is unset no freeze is enforced (a note says so); the owner sets it to the real deadline.
# An owner approval label only counts when the repo owner applied it directly (not through any GitHub App,
# such as the Claude app) AFTER GitHub recorded the push of the PR's current head commit (the head commit's
# check-suite creation time, which the pusher can't set; git commit dates can be faked). Pushing new commits
# also removes the label, as housekeeping.
set -euo pipefail

: "${GITHUB_REPOSITORY:?}" "${PR_NUMBER:?}" "${HEAD_SHA:?}" "${EVENT_ACTION:?}"
OWNER="${GITHUB_REPOSITORY%%/*}"
API="repos/${GITHUB_REPOSITORY}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
problems=()
notes=()

# DRY_RUN=1 (for testing the script by hand) reads the PR but posts no status and removes no labels.
status() { # state description
  if [[ "${DRY_RUN:-}" == "1" ]]; then echo "[dry-run] status ${1}: ${2:0:139}"; return; fi
  gh api -X POST "${API}/statuses/${HEAD_SHA}" -f state="$1" -f context="guardrails/policy" -f description="${2:0:139}" \
    -f target_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-0}" >/dev/null
}
status pending "Checking repository policy"

# ---- owner approvals (labels applied by the owner directly, after the latest push) ----
# every page of events, merged into one array (--paginate alone prints one array per page)
gh api --paginate "${API}/issues/${PR_NUMBER}/events" | jq -s 'add // []' > "${WORK}/events.json"
# when GitHub recorded the push of the current head commit; empty if not known yet (then no approval counts)
pushed_at="$(gh api "${API}/commits/${HEAD_SHA}/check-suites" --jq '[.check_suites[].created_at] | min // ""' 2>/dev/null || true)"
gh api "${API}/pulls/${PR_NUMBER}" > "${WORK}/pr.json"
labels="$(jq -r '.labels[].name' "${WORK}/pr.json")"
remove_label() { # fails closed: an approval that can't be removed after a push must not keep counting
  if [[ "${DRY_RUN:-}" == "1" ]]; then echo "[dry-run] would remove label $1"; return; fi
  gh api -X DELETE "${API}/issues/${PR_NUMBER}/labels/$1" >/dev/null 2>&1 \
    || problems+=("Couldn't remove \`$1\` after a new push; failing closed. Remove it and re-apply after review.")
}
approved() { # label -> 0 if currently applied, last applied by the owner directly (no app), after the push
  local label="$1"
  grep -qxF "$label" <<<"$labels" || return 1
  [[ -n "$pushed_at" ]] || return 1
  jq -e --arg l "$label" --arg o "$OWNER" --arg p "$pushed_at" '
    [.[] | select(.event == "labeled" and .label.name == $l)] | last
    | select(. != null)
    | .actor.login == $o and .actor.type == "User" and .performed_via_github_app == null and .created_at > $p' "${WORK}/events.json" >/dev/null
}
# a push invalidates earlier approvals: they must be re-applied after reviewing the new commits
if [[ "$EVENT_ACTION" == "synchronize" ]]; then
  for l in owner-approved-paths freeze-exception; do
    if grep -qxF "$l" <<<"$labels"; then remove_label "$l"; notes+=("New commits pushed: \`$l\` was removed and must be re-applied after review."); fi
  done
  labels="$(gh api "${API}/issues/${PR_NUMBER}/labels" --jq '.[].name')"
fi

# ---- 0. only pull requests into main are judged; every changed file must be listed ----
base_ref="$(jq -r '.base.ref' "${WORK}/pr.json")"
[[ "$base_ref" == "main" ]] || problems+=("The pull request targets \`${base_ref}\`, not \`main\`. Only pull requests into main may merge.")

# ---- 1. material changes need the owner's review; routine ones don't ----
gh api --paginate "${API}/pulls/${PR_NUMBER}/files" --jq '.[] | [.filename, (.previous_filename // ""), .status, (.deletions | tostring), ((.patch != null) | tostring)] | @tsv' > "${WORK}/files.tsv"
# API patches carry no "+++" file headers, so every line starting with "+" is an added line
gh api --paginate "${API}/pulls/${PR_NUMBER}/files" --jq '.[] | select(.patch != null) | .filename as $f | .patch | split("\n")[] | select(startswith("+")) | $f + "\t" + .[1:]' > "${WORK}/added.tsv"
listed="$(wc -l < "${WORK}/files.tsv" | tr -d ' ')"
changed="$(jq -r '.changed_files' "${WORK}/pr.json")"
if [[ "$listed" != "$changed" || "$listed" -ge 3000 ]]; then
  problems+=("GitHub listed ${listed} of ${changed} changed files (the API stops at 3000), so the change can't be fully inspected. Split the pull request.")
fi
bash "${HERE}/classify.sh" "${WORK}/files.tsv" "${WORK}/added.tsv" > "${WORK}/risk.tsv"
while IFS=$'\t' read -r kind reason; do
  if [[ "$kind" == "BLOCK" ]]; then problems+=("$reason")
  elif approved owner-approved-paths; then notes+=("Owner reviewed: ${reason}")
  else problems+=("Material change, needs the owner's review (label \`owner-approved-paths\`, applied by ${OWNER} by hand after the last push): ${reason}"); fi
done < "${WORK}/risk.tsv"
[[ -s "${WORK}/risk.tsv" ]] || notes+=("Routine change: no material paths, data writes or weakened tests. Merges once \`test\` passes and an independent review signs it off.")

# ---- 2. AI attribution (commits and PR body) ----
attr_re='(^|[^a-z])(co-authored-by:|claude-session:)|generated (with|by) \[?claude'
gh api --paginate "${API}/pulls/${PR_NUMBER}/commits" --jq '.[] | .sha[0:7] + " " + (.commit.message | gsub("\n"; "\u001f"))' > "${WORK}/commits.txt"
bad_commits="$(tr '\037' '\n' < "${WORK}/commits.txt" | awk '/^[0-9a-f]{7} /{sha=substr($0,1,7)} {print sha "\t" $0}' | grep -iE "$attr_re" | cut -f1 | sort -u | tr '\n' ' ' || true)"
[[ -n "$bad_commits" ]] && problems+=("Commit messages carry co-author, session or Generated-with/by lines (CLAUDE.md forbids them): ${bad_commits}")
# commits must be authored and committed by people, not by an AI identity: promote with scripts/agents/promote.sh
bad_authors="$(gh api --paginate "${API}/pulls/${PR_NUMBER}/commits" --jq '.[] | select(((.commit.author.email + " " + .commit.committer.email) | test("noreply@anthropic\\.com|claude\\[bot\\]"; "i")) or (.commit.author.name | test("^claude( code)?$"; "i")) or (.commit.committer.name | test("^claude( code)?$"; "i"))) | .sha[0:7]' | tr '\n' ' ' || true)"
[[ -n "$bad_authors" ]] && problems+=("Commits authored or committed by an AI identity (re-author as the owner with scripts/agents/promote.sh): ${bad_authors}")
# the PR template's own checklist lines mention these phrases; ignore checklist lines, check everything else
if jq -r '.body // ""' "${WORK}/pr.json" | grep -vE '^[[:space:]]*-[[:space:]]*\[[ xX]\]' | grep -qiE "$attr_re"; then
  problems+=("The PR description carries a Generated-with/by, co-author or session line.")
fi

# ---- 3 & 4. added lines: secrets and real-looking email addresses ----
secret_re='(FlyV1 [A-Za-z0-9+/=_-]{20,}|fo1_[A-Za-z0-9_-]{20,}|fm[12]_[A-Za-z0-9_-]{20,}|re_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|cs_live_[A-Za-z0-9_-]{20,}|(SMTP_PASS|APP_SECRET|RESEND_API_KEY|FLY_API_TOKEN)[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9+/_.-]{8,})'
# documentation placeholders such as cs_live_XXXXXXXX or re_xxxxxxxx are not secrets
sec="$(grep -E "$secret_re" "${WORK}/added.tsv" | grep -vE '(cs_live_|re_|fo1_|sk-ant-|gh[pousr]_)[Xx*]{8,}([^A-Za-z0-9]|$)' | cut -f1 | sort -u | tr '\n' ' ' || true)"
[[ -n "$sec" ]] && problems+=("Added lines look like secrets or credentials in: ${sec}")
badfiles="$(cut -f1 "${WORK}/files.tsv" | grep -E '(^|/)\.env($|\.)|(^|/)\.netrc$|\.(pem|key|p12|pfx|db|sqlite3?)$|^data/|^\.e2e-(data|mail)/' | grep -vE '(^|/)\.env\.example$' | tr '\n' ' ' || true)"
[[ -n "$badfiles" ]] && problems+=("Adds secret or data files: ${badfiles}")
emails="$(cut -f2 "${WORK}/added.tsv" | grep -oiE '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}' | sort -u \
  | grep -viE '@(([a-z0-9-]+\.)*example\.(com|org|net)|([a-z0-9-]+\.)*[a-z0-9-]+\.(test|invalid|example|localhost)|users\.noreply\.github\.com|resend\.dev|anthropic\.com)$' | tr '\n' ' ' || true)"
[[ -n "$emails" ]] && problems+=("Adds real-looking email addresses (test data must use example.com, .test or .invalid): ${emails}")

# ---- 5. submission freeze ----
freeze="${AGENT_FREEZE_AT:-}"
if [[ -z "$freeze" ]]; then
  notes+=("No submission freeze is configured. Set the repository variable AGENT_FREEZE_AT to the real deadline minus 12 hours, in UTC (e.g. 2026-11-11T14:00:00Z), to enforce it.")
elif ! [[ "$freeze" =~ (Z|[+-][0-9]{2}:[0-9]{2})$ ]]; then
  problems+=("AGENT_FREEZE_AT must end in Z or a UTC offset (e.g. 2026-11-11T14:00:00Z), not: ${freeze}")
elif ! fz="$(python3 -c 'import sys, datetime; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).timestamp()))' "$freeze" 2>/dev/null)"; then
  problems+=("AGENT_FREEZE_AT is not a valid time: ${freeze}")
elif (( $(date -u +%s) >= fz )); then
  if approved freeze-exception; then notes+=("After the freeze (${freeze}), with an owner freeze exception.")
  else problems+=("The submission freeze started at ${freeze}. No pull request may merge without an owner \`freeze-exception\` label."); fi
fi

# ---- report ----
{
  echo "## Repository policy"
  if (( ${#problems[@]} )); then echo "**Failed:**"; printf -- '- %s\n' "${problems[@]}"; else echo "Passed."; fi
  if (( ${#notes[@]} )); then echo; echo "Notes:"; printf -- '- %s\n' "${notes[@]}"; fi
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
if (( ${#problems[@]} )); then
  status failure "${#problems[@]} policy problem(s): see the agent-guard run summary"
  printf '::error::%s\n' "${problems[@]}"
  exit 1
fi
status success "Policy checks passed"
