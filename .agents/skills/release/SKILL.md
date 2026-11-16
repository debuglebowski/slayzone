---
name: release
description: "Create a new release for SlayZone"
trigger: none
---

Create a new release for SlayZone. The version argument is: $ARGUMENTS

## Steps

### 1. Determine version

Read the current version from `packages/apps/app/package.json`.

Interpret `$ARGUMENTS`:
- `patch` — bump the patch number (e.g. 0.2.0 -> 0.2.1)
- `minor` — bump the minor number (e.g. 0.2.1 -> 0.3.0)
- `major` — bump the major number (e.g. 0.3.0 -> 1.0.0)
- Anything else — treat as an explicit version string (e.g. `0.5.0`)

### 2. Auto-title the task

Invoke the `slay-auto-title` skill to rename the current task to reflect the release (e.g. `Release v<new-version>`). Skip if the task title already matches.

### 3. Bump version

Update `"version"` in `packages/apps/app/package.json` (canonical source of truth), then run:

```
node scripts/sync-versions.mjs
```

This stamps the shared version into every workspace manifest (cli, all domains/shared/apps, root, website). Do NOT hand-edit other manifests — the script owns them and `pnpm lint:versions` enforces it.

### 4. Generate changelog

Run `npx changelogen --from <previous-tag> --to main --output CHANGELOG.md --hideAuthorEmail` (use `pnpx` if available).

The tool will prepend a `## <old-tag>...main` section to CHANGELOG.md. After it runs:
- Rename the new section header from `## <old-tag>...main` to `## v<new-version>`
- Update the compare link to `compare/<old-tag>...v<new-version>`
- Verify the file has no duplicate sections from the tool overwriting previous edits

### 5. Update in-app changelog

Read `packages/domains/onboarding/src/client/changelog/changelog-data.json`.

Add a new entry at the top of the JSON array for the new version:
- `version`: the new version string (without `v` prefix)
- `date`: today's date in `YYYY-MM-DD` format
- `tagline`: a short, catchy 2-4 word tagline summarizing the release theme
- `items`: user-facing changes only (breaking changes, features, improvements, fixes). Skip CI, docs, tests, chores, website-only changes. Keep descriptions concise (1 sentence). Match the tone and style of existing entries. **List `breaking` items first**, then features, improvements, fixes.

Categories:
- `breaking` — backwards-incompatible changes that require user action (migrations, removed features, changed defaults, renamed settings)
- `feature` — new user-facing capabilities
- `improvement` — enhancements to existing features
- `fix` — bug fixes users would notice

**Deduplicate by feature, not by commit.** One feature often spans multiple commits (initial impl + follow-up fixes + polish + refactor). Collapse all commits touching the same user-facing capability into a single entry. Group by what the user sees, not by git history. If a feature was added then later fixed in the same release window, emit one entry describing the final state (usually `feature`, not `feature` + `fix`). Same for iterative improvements to one area — merge into one `improvement` entry.

### 6. Commit and confirm

```
git add -A -- '*package.json'
git add CHANGELOG.md packages/domains/onboarding/src/client/changelog/changelog-data.json
git commit -m "release: v<new-version>"
```

**Stop and ask the user to confirm** before tagging and pushing. Show them:
- The version bump (old -> new)
- Number of changelog items by category
- That tagging will trigger CI builds

Only after confirmation:
```
git tag v<new-version>
git push && git push origin v<new-version>
```

### 7. Confirm

Print a summary:
- Previous version -> new version
- Number of breaking changes/features/improvements/fixes in the in-app changelog
- Link to the GitHub Actions release run (https://github.com/debuglebowski/SlayZone/actions)

### 8. Freeze a migration persona of this release

Every stable release adds one persona to the migration suite (`tools/migration-personas/`, README there): this release's real build, used by a scripted user, frozen — so every future migration is tested against the data THIS release writes. Do it once CI has published the release.

1. Wait until the release has its Linux build: `gh release view v<new-version> --json assets -q '.assets[].name'` lists `SlayZone-amd64.deb` and `SHA256SUMS.txt` (use the `release-monitor-ci` skill to follow CI).
2. Copy the newest full journey to `tools/migration-personas/generate/journeys/v<new-version>-full/journey.sh`, and the newest full persona to `tools/migration-personas/personas/p<NN>-v<nodots>-full/persona.json` (next free `NN`; set `release`, `journey`, `summary` — schema = last migration number at the tag).
3. `tools/migration-personas/generate/generate.sh p<NN>-v<nodots>-full`. If the journey fails, this release changed a CLI flag or API the journey uses: adapt the journey to the release's own source (`git show v<new-version>:<path>`), never the working tree. Stop and report if it cannot be made to work.
4. `tools/migration-personas/run.sh --twice --update p<NN>-v<nodots>-full` — must end with "deterministic across two runs" and every line of `personas/p<NN>-…/expected/invariants.txt` `ok` or `note`. A `FAIL` is an upgrade bug in today's code: stop and report it.
5. Commit only the persona's paths: `git commit -m "test(migrations): v<new-version> persona" -- tools/migration-personas`.

## Important

- The release CI triggers on `v*` tag push — builds macOS/Linux/Windows + deploys Convex
- All workspace manifests share one version, stamped from `packages/apps/app/package.json` by `scripts/sync-versions.mjs`. Only the app version matters to electron-builder; the rest (incl. root) are synced for consistency and enforced by `pnpm lint:versions`.
- Always confirm with the user before running `git push`
- The persona (step 8) is for stable releases only, never betas
