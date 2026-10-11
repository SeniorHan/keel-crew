---
name: committing-push-merge
description: Run when the user says commit and push, publish, or merge. It runs local tests, creates a topic branch, raises a PR, merges it with the gh CLI and updates local main.
---

# Commit and push

**"Commit and push" always means this full flow, with no questions asked:**

1. run the local tests (`npm run check`, `npm test`, `git diff --check`);
2. create a new topic branch from `origin/<default>`;
3. commit, push, and raise a PR with `gh`;
4. merge that PR with `gh pr merge --squash`;
5. update the local default branch to the merged result.

We use PRs so the changelog is updated: `.github/scripts/changelog.ts` builds release notes from merged PRs. So never push or commit directly to the default branch, and never merge locally. Run tests locally; don't wait for CI and never use `--admin`/`--auto` or bypass branch protections.

## Run it

From the repo root:

```sh
node .agents/skills/committing-push-merge/scripts/publish.mjs --message "feat: user-facing summary"
```

- `--message` is a conventional commit (`feat:`, `fix:`, `docs:`...). It becomes the commit and PR title and lands in the release notes, so make it meaningful.
- By default **all** current changes are committed. If the tree holds unrelated work, list only the files that belong after `--`: `... --message "fix: x" -- src/a.ts tests/a.test.ts`. Everything else stays untouched.
- Optional: `--branch <name>` (default `<type>/<slug>`, must be new) and `--body-file <file>` (default is the message plus the validation results).

The script stops on the first failure. Exit `0` = merged (it prints the PR URL and `RESULT: merged`) and you are left on the updated default branch. `1` = failed, nothing merged (fix and re-run). `2` = bad arguments. `3` = PR open but not merged (e.g. branch protection): report the PR URL and blocker; don't bypass it.

After it finishes, report the PR URL, the merge commit and the checks that ran.

## Out of scope

No version bumps, tags, npm publishing or GitHub Releases (use `../release/SKILL.md` only when asked). Don't edit the generated `CHANGELOG.md`. If the script can't handle an unusual repo state, follow the same steps by hand with git and `gh`. If using Worktrunk, call it through the Worktrunk tool.
