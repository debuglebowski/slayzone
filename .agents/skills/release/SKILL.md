Create a new release for SlayZone. The version argument is: $ARGUMENTS

## Steps

### 1. Determine version

Read the current version from `packages/apps/app/package.json`.

Interpret `$ARGUMENTS`:
- `patch` — bump the patch number (e.g. 0.2.0 -> 0.2.1)
- `minor` — bump the minor number (e.g. 0.2.1 -> 0.3.0)
- `major` — bump the major number (e.g. 0.3.0 -> 1.0.0)
- Anything else — treat as an explicit version string (e.g. `0.5.0`)

### 2. Bump version

Update `"version"` in `packages/apps/app/package.json` to the new version.

### 3. Generate changelog

Run `npx changelogen --from <previous-tag> --to main --output CHANGELOG.md --hideAuthorEmail` (use `pnpx` if available).

The tool will prepend a `## <old-tag>...main` section to CHANGELOG.md. After it runs:
- Rename the new section header from `## <old-tag>...main` to `## v<new-version>`
- Update the compare link to `compare/<old-tag>...v<new-version>`
- Verify the file has no duplicate sections from the tool overwriting previous edits

### 4. Update in-app changelog

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

### 5. Commit and confirm

```
git add CHANGELOG.md packages/apps/app/package.json packages/apps/app/src/renderer/src/components/changelog/changelog-data.json
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

### 6. Confirm

Print a summary:
- Previous version -> new version
- Number of features/improvements/fixes in the in-app changelog
- Link to the GitHub Actions release run (https://github.com/debuglebowski/SlayZone/actions)

## Important

- The release CI triggers on `v*` tag push — builds macOS/Linux/Windows + deploys Convex
- Do NOT modify `package.json` in the monorepo root — only `packages/apps/app/package.json` matters for electron-builder
- Always confirm with the user before running `git push`
