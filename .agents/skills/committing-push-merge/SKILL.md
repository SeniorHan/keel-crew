---
name: committing-push-merge
description: Commit, push, and merge repository changes through a GitHub pull request. Use whenever the user asks to commit and push, push changes, or merge completed work. Run tests locally and merge without waiting for CI so changes are included in generated changelogs.
---

# Committing, pushing, and merging

## Required path

Whenever the user asks to **commit and push**, use **branch → commit → push → PR → merge**, not a direct push to the default branch or a local merge followed by a default-branch push. A merged GitHub PR is required for changelog generation: this repository's `.github/scripts/changelog.ts` and GitHub release notes collect merged pull requests between version tags. Direct commits can be omitted from the generated notes.

Treat ordinary commit-and-push requests as requests to complete this PR path, including merging. If the user explicitly asks to leave a PR open or only commit locally, honor that narrower scope.

**Run tests locally; do not wait for CI.** Attempt the merge immediately after creating the PR. Do not watch/poll Actions, use `gh pr checks --watch`, or use `--auto` to defer the merge until checks finish. Respect branch protections: if GitHub blocks the merge, report the PR URL and blocker instead of bypassing protections, using `--admin`, or weakening checks.

## Workflow

1. Inspect `git status`, the current branch, remotes, and the diff. Preserve unrelated changes; stage only the intended files. Confirm the repository's default branch with `gh repo view --json defaultBranchRef`. Fetch its latest remote state and check for unexpected divergence.
2. Work on a descriptive topic branch based on the default branch. If intended changes are already uncommitted on the default branch, `git switch -c <branch>` preserves them while moving the work off that branch. Reuse an existing appropriate topic branch; do not force-push or reset someone else's work. When using Worktrunk, invoke it through the Worktrunk tool.
3. Validate the actual patch locally:
   ```sh
   npm run check
   npm test
   git diff --check
   ```
   Add relevant focused checks as needed. Do not push/merge after a failing local check; fix it or report the blocker. Existing passing results may be reused only if they cover the exact unchanged patch. Note visual or environment limitations honestly.
4. Stage explicit paths, review the staged diff, and commit with a descriptive conventional message. Push only the topic branch:
   ```sh
   git add <intended-files>
   git diff --cached --check
   git diff --cached
   git commit -m "fix: describe the user-facing change"
   git push -u origin <branch>
   ```
5. Create a PR with a meaningful title (used in release notes) and a body describing the change, local validation results, and limitations. Use an existing open PR for this branch if one already exists; do not create duplicates.
   ```sh
   gh pr create --base <default-branch> --head <branch> \
     --title "fix: describe the user-facing change" --body-file <pr-body-file>
   ```
6. Merge immediately, without waiting for CI, using an allowed repository merge method. Squash is suitable when allowed; pin the reviewed head SHA:
   ```sh
   HEAD_SHA=$(git rev-parse HEAD)
   gh pr merge <pr-number> --squash --match-head-commit "$HEAD_SHA"
   gh pr view <pr-number> --json url,state,mergedAt,mergeCommit
   ```
   This last query verifies merge state, not CI. If merging is blocked or the head changed, stop and report the state; do not claim that an open/queued PR is merged.
7. Report the PR URL, commit/merge outcome, and local checks. Only synchronize local default-branch state with a fast-forward when safe; never discard uncommitted work or delete a branch/worktree that is still in use.

## Scope

This workflow publishes ordinary source/documentation changes. It does **not** authorize a version bump, tag, npm publication, or GitHub Release. Follow the separate `../release/SKILL.md` only when the user explicitly requests a release; ordinary changes still go through a PR first. Do not edit the generated `CHANGELOG.md` to compensate for skipping a PR.

Run `/reload` after adding or editing this skill. Invoke `/skill:committing-push-merge` explicitly when needed.
