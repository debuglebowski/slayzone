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

Update `"version"` in both:
- `packages/apps/app/package.json`
- `packages/apps/cli/package.json`

### 4. Generate changelog

Run `npx changelogen --from <previous-tag> --to main --output CHANGELOG.md --hideAuthorEmail` (use `pnpx` if available).

The tool will prepend a `## <old-tag>...main` section to CHANGELOG.md. After it runs:
- Rename the new section header from `## <old-tag>...main` to `## v<new-version>`
- Update the compare link to `compare/<old-tag>...v<new-version>`
- Verify the file has no duplicate sections from the tool overwriting previous edits

### 5. Update in-app changelog

Read `packages/apps/app/src/renderer/src/components/changelog/changelog-data.json`.

Add a new entry at the top of the JSON array for the new version:
- `version`: the new version string (without `v` prefix)
- `date`: today's date in `YYYY-MM-DD` format
- `tagline`: a short, catchy 2-4 word tagline summarizing the release theme
- `items`: user-facing changes only (features, improvements, fixes). Skip CI, docs, tests, chores, website-only changes. Keep descriptions concise (1 sentence). Match the tone and style of existing entries.

Categories:
- `feature` — new user-facing capabilities
- `improvement` — enhancements to existing features
- `fix` — bug fixes users would notice

**Deduplicate by feature, not by commit.** One feature often spans multiple commits (initial impl + follow-up fixes + polish + refactor). Collapse all commits touching the same user-facing capability into a single entry. Group by what the user sees, not by git history. If a feature was added then later fixed in the same release window, emit one entry describing the final state (usually `feature`, not `feature` + `fix`). Same for iterative improvements to one area — merge into one `improvement` entry.

### 6. Commit and confirm

```
git add CHANGELOG.md packages/apps/app/package.json packages/apps/cli/package.json packages/apps/app/src/renderer/src/components/changelog/changelog-data.json
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
- Number of features/improvements/fixes in the in-app changelog
- Link to the GitHub Actions release run (https://github.com/debuglebowski/SlayZone/actions)

## Important

- The release CI triggers on `v*` tag push — builds macOS/Linux/Windows + deploys Convex
- Do NOT modify `package.json` in the monorepo root — only `packages/apps/app/package.json` matters for electron-builder
- Always confirm with the user before running `git push`
