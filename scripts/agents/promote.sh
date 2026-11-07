#!/usr/bin/env bash
# Owner-only. Turns a reviewed sandbox pull request into ONE clean commit on a new local branch of this
# repository, authored by the owner's own git identity. The agent's commits are not copied: their history
# stays in the sandbox pull request, which is the internal provenance record. Never pushes.
#
#   scripts/agents/promote.sh <sandbox-pr-number> <new-branch> "<commit message>"
#
# Then review the commit, push the branch and open the pull request yourself.
set -euo pipefail
SANDBOX="parammadan/agreementos-agents"
[[ $# -eq 3 ]] || { echo "usage: $0 <sandbox-pr-number> <new-branch> \"<commit message>\"" >&2; exit 2; }
pr="$1" branch="$2" msg="$3"

[[ -z "$(git status --porcelain)" ]] || { echo "Working tree not clean. Commit or stash first." >&2; exit 1; }
if grep -qiE 'co-authored-by:|claude-session:|generated (with|by)' <<<"$msg"; then echo "The commit message must not carry attribution lines." >&2; exit 1; fi
who="$(git config user.name) <$(git config user.email)>"
if grep -qiE 'anthropic|^claude' <<<"$who"; then echo "Git identity is '$who'; promote as the owner." >&2; exit 1; fi

git remote get-url agents >/dev/null 2>&1 || git remote add agents "https://github.com/${SANDBOX}.git"
git fetch -q origin main
git fetch -q agents main "+refs/pull/${pr}/head:refs/sandbox/pr-${pr}"
base="$(git merge-base FETCH_HEAD "refs/sandbox/pr-${pr}" 2>/dev/null || git merge-base agents/main "refs/sandbox/pr-${pr}")"

# only the agent's changes: from where its branch left the sandbox's main to the PR head
git switch -q -c "$branch" origin/main
if ! git diff --binary "$base" "refs/sandbox/pr-${pr}" | git apply --index --3way; then
  echo "The changes don't apply cleanly on main. Resolve on branch '$branch' or ask the agent to rebase." >&2; exit 1
fi
git commit -q -m "$msg"

# verify the result before anything leaves this machine
if git log -1 --format='%an %ae %cn %ce' | grep -qiE 'anthropic|claude'; then echo "Commit identity check failed." >&2; exit 1; fi
if git log -1 --format=%B | grep -qiE 'co-authored-by:|claude-session:|generated (with|by)'; then echo "Commit message check failed." >&2; exit 1; fi
echo "Created ${branch}: $(git log -1 --format='%h %s') by $(git log -1 --format='%an <%ae>')"
git show --stat --format= HEAD
echo
echo "Next, by hand after review:  git push -u origin ${branch}  &&  gh pr create --base main --head ${branch}"
echo "Provenance note for sandbox PR #${pr}:  promoted as $(git rev-parse --short HEAD) on ${branch}"
