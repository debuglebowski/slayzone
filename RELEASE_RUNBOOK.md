# Release Runbook

This project uses a shared release foundation workflow for all channels.

## Workflows

- `release.yml`: tag-triggered release and manual dispatch.
- `release-pr-dry-run.yml`: dry-run validation on release-related pull requests.
- `release-foundation.yml`: reusable core pipeline (preflight -> Convex deploy gate -> build -> checksums/manifest -> per-channel publish).

Retention policy:
- Intermediate build artifacts (`release-build-*` and `release-bundle`) are retained for 90 days.
- Within 90 days, failed channel publish jobs can be rerun without rebuilding.
- After 90 days, rerun the `Release` workflow in `publish` mode for the same tag to regenerate bundle artifacts.

## CI Policy Gates

- `CI / workflow-lint` runs `actionlint` and release workflow policy checks.
- `CI / check` runs typecheck/build validation.
- In GitHub branch protection for `main`, mark both checks as required before merge.

## Required Secrets

Set these in repository secrets before publish mode runs:

- `CONVEX_DEPLOY_KEY`: Convex production deploy key used by `npx convex deploy`.
- `MACOS_CERTIFICATE`: Base64-encoded `.p12` signing certificate for macOS.
- `MACOS_CERTIFICATE_PWD`: Password for the `.p12` certificate.
- `APPLE_ID`: Apple account used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD`: App-specific password for notarization.
- `APPLE_TEAM_ID`: Apple Developer Team ID.
- `POSTHOG_API_KEY`: Production PostHog key for release builds.
- `POSTHOG_HOST`: PostHog host URL.
- `VITE_CONVEX_URL`: Production Convex URL.
- `WIN_CSC_LINK`: Optional base64/URL Windows signing certificate for signed `.exe` output.
- `WIN_CSC_KEY_PASSWORD`: Password for `WIN_CSC_LINK`.

Notes:
- `GITHUB_TOKEN` is provided automatically by GitHub Actions.
- Dry-run mode does not require signing or notarization secrets.
- Dry-run mode skips Convex deploy.
- Publish mode validates required deploy/signing/build secrets at workflow start and fails fast if any are missing.

## Standard Release (Tag Trigger)

1. Ensure `main` is green.
2. Create and push a semver tag:

```bash
git checkout main
git pull --ff-only
git tag vX.Y.Z
git push origin vX.Y.Z
```

3. Wait for `Release` workflow to complete.
4. Verify artifacts in the GitHub Release:
- Installers/packages for macOS, Windows, Linux.
- `SHA256SUMS.txt`
- `release-manifest.json`

Publish mode behavior:
- Convex deploy runs before packaging.
- If Convex deploy fails, the release workflow fails and no channel publish runs.

## Manual Dry-Run

Run `Release` (`release.yml`) with:
- `mode = dry-run`
- `tag = v0.0.0-dryrun` (or another semver-like tag)
- `channels = ["stable"]` or a JSON array

## Manual Publish (Without New Tag Push)

Run `Release` (`release.yml`) with:
- `mode = publish`
- `tag = vX.Y.Z`
- `channels = ["stable"]` or channel array

This is useful for controlled re-publish attempts.

## Rerunning Failed Channel Publish Jobs

Channel publishing is isolated from building.

If a channel job fails:
1. Open the failed `Release` workflow run.
2. Choose `Re-run failed jobs` (or re-run only the failed publish job in UI).
3. Do not restart the whole workflow unless build artifacts are missing.

Why safe:
- Publish jobs consume immutable uploaded build artifacts (`release-bundle`).
- Upload uses `--clobber`, so retrying replaces assets idempotently.
- The manifest commit is resolved from the exact built ref (`git rev-parse HEAD`), not caller context SHA.

## Rollback and Recovery

### Scenario A: Publish failed for one channel

- Re-run only the failed channel publish job.
- No rebuild is needed.

### Scenario A2: Channel rerun needed after artifact retention expiry

If the original run is older than 90 days and `release-bundle` has expired:
1. Run `Release` (`release.yml`) manually with:
   - `mode = publish`
   - `tag = vX.Y.Z` (same tag)
   - `channels = ["<failed-channel>"]` (or `["stable"]` if stable failed)
2. The workflow rebuilds, regenerates manifest/checksums, and republishes channel assets with `--clobber`.

### Scenario B: Wrong assets uploaded for a tag

1. Set release back to draft (optional safety gate):

```bash
gh release edit vX.Y.Z --draft
```

2. Re-run publish job for that channel from Actions.
3. Verify `release-manifest.json` and `SHA256SUMS.txt` against expected files.
4. Publish release again:

```bash
gh release edit vX.Y.Z --draft=false
```

### Scenario C: Bad public release already consumed

1. Do not reuse the version.
2. Publish a new patch tag (`vX.Y.(Z+1)`) with fixes.
3. Optionally mark old release clearly in notes as superseded.

### Scenario D: Incorrect tag pushed accidentally

If no downstream clients should consume it:

```bash
gh release delete vX.Y.Z --yes
git push --delete origin vX.Y.Z
git tag -d vX.Y.Z
```

Then create and push the correct tag.

## Manifest and Checksum Contract

Each release bundle includes:

- `SHA256SUMS.txt`: SHA256 for each published asset.
- `release-manifest.json`: canonical metadata containing:
  - schema version
  - tag/version/commit/mode/channels
  - artifact names, sizes, SHA256 hashes

Consumers should treat `release-manifest.json` as the source of truth for asset metadata.
