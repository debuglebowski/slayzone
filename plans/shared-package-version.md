# Shared package version — one version, sustainable bumps

## Goal

Every workspace package shares one version string, and bumping stays a single
command that can never silently drift again.

## Current state (audited)

- Root `slayzone-monorepo` = `0.1.30` — stale, unused, misleading.
- `@slayzone/app` = `0.35.0` — the real product version (drives electron-builder + release CI on `v*` tags).
- `@slayzone/cli` = `0.35.0` — kept in sync only by convention.
- 50+ domain/shared/apps packages = `0.0.0`.
- `@slayzone/website` = no `version` field.
- All packages `private:true`; all 327 internal deps use `workspace:*`.
  → version is cosmetic for resolution. **Zero break risk in bumping** — no dep range needs touching.

## Problem: 3 bump paths, all partial

| Path | Bumps |
|------|-------|
| `release:patch/minor/major` (`npm version` on app filter) | **app only** — cli drifts |
| `release` skill | app + cli (manual edit) |
| `release:beta` → `cut-beta.mjs` | app + cli |

app is canonical version everywhere; nothing reads root version except… nothing. Root `0.1.30` is pure noise.

## Design

**Single source of truth = `@slayzone/app` version.** One script stamps every other manifest to match. Every bump path funnels through it. A lint check makes the invariant self-enforcing.

### 1. `scripts/sync-versions.mjs` (new)

- Read canonical version from `packages/apps/app/package.json`.
- Modes:
  - `--check` — exit 1 + list offenders if any tracked manifest ≠ canonical. No writes. (used by lint/CI)
  - default (write) — stamp canonical into every target manifest.
- Targets = all 57 real workspace manifests + root `package.json` + `website/package.json` (add `version` field if absent, placed right after `name`).
- Explicitly skip `packages/apps/cli/test/package.json` (bare `{type:module}` fixture, not a workspace pkg).
- Preserve field order (website/root gain `version` right after `name`), 2-space indent, trailing newline — match existing style so diffs stay clean.
- Idempotent: re-run = no-op.

### 2. Wire bump paths through it

- `cut-beta.mjs`: after writing app+cli, run the sync writer so betas stamp everything too. (Keep app+cli explicit writes; sync covers the rest.)
- `tag-release.sh`: after `VERSION=…`, run sync writer + `git add -A` the changed manifests before commit (so a stable release commits the synced set, not just app).
- `release` skill (SKILL.md step 3): replace "edit app + cli" with "edit app version, then run `node scripts/sync-versions.mjs`". Also drop/loosen the "do NOT modify root package.json" note — root now intentionally tracks the shared version (still irrelevant to electron-builder, but no longer stale).
- `release:*` npm scripts: keep `npm version` on app (so app stays canonical + git-side effects), then chain `&& node scripts/sync-versions.mjs`. Add a root `sync-versions` script alias.

### 3. Drift guard (lint + CI)

- New root script `"lint:versions": "node scripts/sync-versions.mjs --check"`.
- Add `lint:versions` into the `lint` script chain (runs in `pnpm lint`, which CI already runs).
- Fails PRs where any manifest desynced.

### 4. One-time initial sync

Run the writer once to stamp all 57 + root + website to `0.35.0`. This is the bulk of the diff (root 0.1.30→0.35.0, all 0.0.0→0.35.0, website gains field).

## Sustainability rationale

- Single source of truth (app) — no second number to remember.
- Every human + scripted path already funnels through app; sync closes the tail.
- `--check` in lint makes desync impossible to merge — the invariant enforces itself, not tribal knowledge.
- Idempotent + order-preserving → clean diffs, safe to re-run anytime.
- No `workspace:*` ranges touched → no resolution risk.

## Files touched

- NEW `scripts/sync-versions.mjs`
- `package.json` (root: version + `lint:versions` + `sync-versions` scripts + lint chain)
- `website/package.json` (+version field)
- 55 other manifests (0.0.0 → 0.35.0; cli already 0.35.0)
- `scripts/tag-release.sh`
- `scripts/release/cut-beta.mjs`
- `.claude/skills/release/SKILL.md`

## Verify

- `node scripts/sync-versions.mjs && node scripts/sync-versions.mjs --check` → clean exit, second run no-op.
- `pnpm install` → lockfile stable (no range changes).
- `pnpm lint:versions` green; break one manifest → red.
- `pnpm typecheck` unaffected.

## Unresolved questions

- Website gets version field — ok, or leave website version-less & exempt in checker? (plan adds field per your "every pkg incl website" choice; flag if you'd rather exempt)
- cli `release:*` — keep `npm version` app-only then sync, vs. move canonical bump elsewhere? (plan keeps app as bump anchor)
