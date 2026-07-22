#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: publish-auto-fix-pr.sh <checkout> <artifact-dir> <branch> <base-branch> <run-id>" >&2
  exit 2
fi

CHECKOUT="$(cd "$1" && pwd)"
ARTIFACT_DIR="$(cd "$2" && pwd)"
BRANCH="$3"
BASE_BRANCH="$4"
RUN_ID="$5"
NODE_BIN="${HOMERAIL_NODE_BIN:-node}"
PUBLICATION="$ARTIFACT_DIR/auto-fix.json"
PATCH="$ARTIFACT_DIR/auto-fix.patch"
MARKDOWN="$ARTIFACT_DIR/auto-fix.md"
BODY="$ARTIFACT_DIR/pull-request-body.md"

if [[ ! "$BRANCH" =~ ^auto-fix/issue-[1-9][0-9]*-[A-Za-z0-9._-]+$ ]] \
  || [[ ! "$BASE_BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] \
  || [[ ! "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$ ]]; then
  echo "Auto Fix publication branch, base, or run ID is invalid." >&2
  exit 1
fi
REPO="$($NODE_BIN -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v.repo))process.exit(1);process.stdout.write(v.repo)' "$PUBLICATION")"
ISSUE="$($NODE_BIN -e 'const fs=require("fs");const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!Number.isInteger(v.issue)||v.issue<1)process.exit(1);process.stdout.write(String(v.issue))' "$PUBLICATION")"
REMOTE="$(git -C "$CHECKOUT" remote get-url origin)"
if [ "$REMOTE" != "https://github.com/$REPO" ] && [ "$REMOTE" != "https://github.com/$REPO.git" ]; then
  echo "Auto Fix checkout origin does not match the published repository." >&2
  exit 1
fi

git -C "$CHECKOUT" switch -c "$BRANCH"
"$NODE_BIN" "$(dirname "$0")/apply-auto-fix-patch.mjs" "$CHECKOUT" "$PUBLICATION" "$PATCH"
git -C "$CHECKOUT" config user.name "github-actions[bot]"
git -C "$CHECKOUT" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git -C "$CHECKOUT" commit -m "fix: address issue #$ISSUE"

GIT_ASKPASS="$(dirname "$0")/github-token-askpass.sh" \
GIT_TERMINAL_PROMPT=0 \
git -C "$CHECKOUT" push --set-upstream origin "$BRANCH"

"$NODE_BIN" "$(dirname "$0")/build-auto-fix-pr-body.mjs" "$PUBLICATION" "$MARKDOWN" "$RUN_ID" "$BODY"
PR_URL="$(gh pr create --repo "$REPO" --base "$BASE_BRANCH" --head "$BRANCH" --draft --title "fix: issue #$ISSUE" --body-file "$BODY")"
if [[ ! "$PR_URL" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*$ ]]; then
  echo "GitHub did not return a canonical pull request URL." >&2
  exit 1
fi
printf '%s\n' "$PR_URL" >"$ARTIFACT_DIR/pr-url.txt"
gh issue comment "$ISSUE" --repo "$REPO" --body "HomeRail Auto Fix completed run \`$RUN_ID\`, passed isolated \`npm run ci\`, and opened Draft PR: $PR_URL"
gh issue edit "$ISSUE" --repo "$REPO" --remove-label auto-fix
echo "$PR_URL"
