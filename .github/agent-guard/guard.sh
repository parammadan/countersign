#!/usr/bin/env bash
# Repository policy check for every pull request, run by .github/workflows/agent-guard.yml.
#
# Runs from the BASE branch under pull_request_target: it never checks out or executes the pull request's
# code, and reads the PR only through the GitHub API. Everything from the PR (branch name, titles, file
# names, patches, commit messages) is treated as untrusted data: passed through env/files, never evaluated.
#
# Fails the `guardrails/policy` commit status when a PR:
#   1. changes a protected path (protected-paths.txt) without an owner approval label,
#   2. carries AI co-author, "Generated with" or session trailers,
#   3. adds secret-looking values or secret/data files,
#   4. adds real-looking email addresses (test data must use example.com / .test / .invalid),
#   5. arrives after the submission freeze (repo variable AGENT_FREEZE_AT) without a freeze exception.
# An owner approval label only counts when the repo owner applied it directly (not through any GitHub App,
# such as the Claude app) after the PR's latest push. Pushing new commits removes it.
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
  gh api -X POST "${API}/statuses/${HEAD_SHA}" -f state="$1" -f context="guardrails/policy" -f description="${2:0:139}" >/dev/null
}
status pending "Checking repository policy"

# ---- owner approvals (labels applied by the owner directly, after the latest push) ----
gh api --paginate "${API}/issues/${PR_NUMBER}/events" > "${WORK}/events.json"
gh api "${API}/pulls/${PR_NUMBER}" > "${WORK}/pr.json"
labels="$(jq -r '.labels[].name' "${WORK}/pr.json")"
remove_label() {
  if [[ "${DRY_RUN:-}" == "1" ]]; then echo "[dry-run] would remove label $1"; return; fi
  gh api -X DELETE "${API}/issues/${PR_NUMBER}/labels/$1" >/dev/null 2>&1 || true
}
approved() { # label -> 0 if currently applied, by the owner, not via an app, and not followed by a push
  local label="$1"
  grep -qxF "$label" <<<"$labels" || return 1
  jq -e --arg l "$label" --arg o "$OWNER" '
    [.[] | select(.event == "labeled" and .label.name == $l)] | last
    | select(. != null) | .actor.login == $o and .performed_via_github_app == null' "${WORK}/events.json" >/dev/null
}
# a push invalidates earlier approvals: they must be re-applied after reviewing the new commits
if [[ "$EVENT_ACTION" == "synchronize" ]]; then
  for l in owner-approved-paths freeze-exception; do
    if grep -qxF "$l" <<<"$labels"; then remove_label "$l"; notes+=("New commits pushed: \`$l\` was removed and must be re-applied after review."); fi
  done
  labels="$(gh api "${API}/issues/${PR_NUMBER}/labels" --jq '.[].name')"
fi

# ---- 1. protected paths ----
gh api --paginate "${API}/pulls/${PR_NUMBER}/files" --jq '.[] | [.filename, (.previous_filename // "")] | @tsv' > "${WORK}/files.tsv"
grep -vE '^\s*(#|$)' "${HERE}/protected-paths.txt" > "${WORK}/protected.re"
hits="$(cut -f1,2 "${WORK}/files.tsv" | tr '\t' '\n' | grep -v '^$' | grep -Ef "${WORK}/protected.re" | sort -u || true)"
if [[ -n "$hits" ]]; then
  if approved owner-approved-paths; then
    notes+=("Protected paths changed with owner approval: $(tr '\n' ' ' <<<"$hits")")
  else
    problems+=("Changes protected paths without owner approval (label \`owner-approved-paths\`, applied by ${OWNER} directly): $(tr '\n' ' ' <<<"$hits")")
  fi
fi

# ---- 2. attribution trailers (commits and PR body) ----
gh api --paginate "${API}/pulls/${PR_NUMBER}/commits" --jq '.[] | .sha[0:7] + " " + (.commit.message | gsub("\n"; "\u001f"))' > "${WORK}/commits.txt"
bad_commits="$(grep -iE $'(^|\x1f)(co-authored-by:|claude-session:)|generated with \\[?claude' "${WORK}/commits.txt" | cut -c1-7 | tr '\n' ' ' || true)"
[[ -n "$bad_commits" ]] && problems+=("Commit messages carry co-author/Generated-with/session trailers (CLAUDE.md forbids them): ${bad_commits}")
if jq -r '.body // ""' "${WORK}/pr.json" | grep -qiE 'generated with \[?claude|co-authored-by:|claude-session:'; then
  problems+=("The PR description carries a Generated-with/co-author/session line.")
fi

# ---- 3 & 4. added lines: secrets and real-looking email addresses ----
gh api --paginate "${API}/pulls/${PR_NUMBER}/files" --jq '.[] | select(.patch != null) | .filename as $f | .patch | split("\n")[] | select(startswith("+") and (startswith("+++") | not)) | $f + "\t" + .[1:]' > "${WORK}/added.tsv"
secret_re='(FlyV1 [A-Za-z0-9+/=_-]{20,}|fo1_[A-Za-z0-9_-]{20,}|fm[12]_[A-Za-z0-9_-]{20,}|re_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|cs_live_[A-Za-z0-9_-]{20,}|(SMTP_PASS|APP_SECRET|RESEND_API_KEY|FLY_API_TOKEN)[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9+/_.-]{8,})'
sec="$(grep -E "$secret_re" "${WORK}/added.tsv" | cut -f1 | sort -u | tr '\n' ' ' || true)"
[[ -n "$sec" ]] && problems+=("Added lines look like secrets or credentials in: ${sec}")
badfiles="$(cut -f1 "${WORK}/files.tsv" | grep -E '(^|/)\.env($|\.)|(^|/)\.netrc$|\.(pem|key|p12|pfx|db|sqlite3?)$|^data/|^\.e2e-(data|mail)/' | grep -vE '(^|/)\.env\.example$' | tr '\n' ' ' || true)"
[[ -n "$badfiles" ]] && problems+=("Adds secret or data files: ${badfiles}")
emails="$(cut -f2 "${WORK}/added.tsv" | grep -oiE '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}' | sort -u \
  | grep -viE '@(([a-z0-9-]+\.)*example\.(com|org|net)|([a-z0-9-]+\.)*[a-z0-9-]+\.(test|invalid|example|localhost)|users\.noreply\.github\.com|resend\.dev|anthropic\.com)$' | tr '\n' ' ' || true)"
[[ -n "$emails" ]] && problems+=("Adds real-looking email addresses (test data must use example.com, .test or .invalid): ${emails}")

# ---- 5. submission freeze ----
freeze="${AGENT_FREEZE_AT:-}"
if [[ -z "$freeze" ]]; then
  problems+=("Repository variable AGENT_FREEZE_AT is not set (ISO time, e.g. 2026-11-11T14:00:00Z). The policy fails closed until it is.")
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
