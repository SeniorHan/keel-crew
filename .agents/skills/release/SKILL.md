---
name: release
description: Release keel-crew. This fork is not published to npm; a release means bumping the version and updating CHANGELOG.md. Use when asked to make a major, minor, or patch release, bump and publish a version, or verify a release.
---

# Release

Note: this fork is not published to npm; a release here only bumps the version and updates CHANGELOG.md. The publish steps below are not applicable and kept for reference only.

1. Confirm the requested bump (`major`, `minor`, or `patch`; ask if unspecified). Start on clean `main`, synced with `origin/main`; commit intended changes first, without including unrelated work.
2. Validate (no build step; this package ships TypeScript sources):
   ```sh
   npm ci && npm run check && npm test && npm pack --dry-run
   ```
3. Bump, commit, and create the annotated tag in one command; replace `<bump>`:
   ```sh
   npm version <bump> -m "chore: release v%s"
   VERSION=$(node -p "require('./package.json').version")
   TAG="v$VERSION"
   SHA=$(git rev-parse HEAD)
   git push --atomic origin main "$TAG"
   ```
4. Find the **tag push** run of `.github/workflows/release.yml` (retry until listed), then watch it:
   ```sh
   gh run list --workflow release.yml --commit "$SHA" --event push --json databaseId,headBranch,status,url
   gh run watch <run-id> --exit-status
   ```
   Select the run whose `headBranch` equals `$TAG`. On failure, inspect `gh run view <run-id> --log-failed`; do not blindly bump again or move the tag.
5. *(Not applicable in this fork — no npm publication.)* Originally: confirm the exact version exists on npm and `latest` matches; retry briefly for registry propagation:
   ```sh
   npm view "keel-crew@$VERSION" version --registry=https://registry.npmjs.org
   npm view keel-crew dist-tags.latest --registry=https://registry.npmjs.org
   ```
   Report version, run URL, and publication status. If verification fails, report unconfirmed publication rather than success.

Publishing (not applicable in this fork): it was handled by Actions via npm OIDC, not local `npm publish`. Trusted publisher was `SeniorHan/keel-crew`, workflow `release.yml`, no environment. The separate `changelog.yml` creates the GitHub Release/CHANGELOG; its success does not prove npm publication.
