# Interactive setup for standalone hub + runner

## Goal
`npx @slayzone/hub` / `npx @slayzone/runner` — when a required (runner) or recommended
(hub) value is missing AND stdin is an interactive TTY, prompt for it, then (after a
`[Y/n]` confirm) persist to `<ROOT>/config.json` before booting. Non-TTY / supervised
keeps today's exact behavior (auto-gen or fail-fast).

## Trigger (decided)
Inline on boot. No new subcommand. Both bins. Confirm-to-save defaults to **Yes** `[Y/n]`.

## Decisions (locked)
1. **Runner join = token-only.** Token embeds hubUrl+cert → single paste, cert-pinned.
   Prompt only when no stored creds AND no `joinToken`. Never prompt hubUrl separately.
2. **Hub prompts `publicUrl` ONLY.** No port prompts (auto-resolve). Empty default =
   loopback token.
3. **Don't persist `runnerName` when the hostname default is accepted** — resolves
   `hostname()` live each boot; persist only a user-typed custom name.
4. **Escape hatch: `SLAYZONE_NONINTERACTIVE=1`** folded into `canPrompt()`. No CLI flag.
5. **Join token shown full in summary** (single-use, dead after first contact — not a
   long-lived secret; copy-verify wins). `runnerTransportSecret` is never prompted.

## Constraints
- **Never prompt** unless `process.stdin.isTTY === true` AND `SLAYZONE_SUPERVISED !== '1'`.
  Non-TTY (CI, pipes, Electron host) → current path unchanged (runner still fails fast with
  its usage error; hub still auto-gens + boots). This preserves `install-handshake.test.ts`
  (spawns with piped stdio → not a TTY) and the supervised sidecar byte-identical boot.
- Env-set values are NOT missing → never prompt for something already in env/config. Keeps
  precedence `env > config.json > prompted > default`.
- Writes go through existing `updateSlayzoneConfig()` (atomic 0600 merge into
  `<ROOT>/config.json`). Self-terminating: a persisted value stops being "missing" → the
  next boot doesn't re-prompt.
- Zero new deps: `node:readline/promises`.

## New shared module: prompt helper
`packages/shared/platform/src/config-prompt.ts` (exposed as
`@slayzone/platform/config-prompt` subpath — same lean-leaf pattern as `slayzone-config`,
so the runner bundle stays free of better-sqlite3).

Exports:
- `canPrompt(): boolean` → `!!process.stdin.isTTY && process.env.SLAYZONE_SUPERVISED !== '1'
  && process.env.SLAYZONE_NONINTERACTIVE !== '1'`.
- `promptLine(question, {default?, mask?}): Promise<string>` — one readline question,
  trims, applies default on empty. (`mask` unused for now; join tokens are paste-visible.)
- `confirm(question, {default=true}): Promise<boolean>` — `[Y/n]`/`[y/N]` per default.
- `runInteractiveConfig({ fields, configPath })` — the orchestrator:
  1. For each missing field, call its prompt; collect `{key,value}` (+ any env-side-effects).
  2. If nothing was collected → return `{}` (no confirm, straight to boot).
  3. Print a summary of what will be written (mask secrets), then `confirm('Save to <path>?')`.
  4. On yes → `updateSlayzoneConfig(patch, configPath)`; on no → keep values in-memory only
     (seed `process.env` for this run, don't persist).
  5. Return the resolved patch either way so the caller seeds `process.env` before its
     existing config-resolution runs.

Design: the helper only *gathers + persists*. It seeds `process.env[…]` for the collected
keys (so the downstream `applyStandaloneHubConfig` / `loadRunnerConfig` see them via the
normal env path), which keeps the resolution logic single-sourced — the prompt is just
another (interactive) env producer sitting at the top.

## Runner wiring (`packages/apps/runner/src/bin.ts`)
Runner is the one that hard-fails today. New order in `main()`:
1. Seed `SLAYZONE_ROOT=cwd` (unchanged, must precede everything).
2. `if (canPrompt())` → check for missing REQUIRED/recommended runner inputs by reading
   `loadSlayzoneConfig()` + env WITHOUT throwing:
   - **join credential**: needed only if the credential store has no stored creds AND no
     `joinToken` in env/config. Use `createFileCredentialStore(hubHostFromUrl(hubUrl)).load()`
     — but hubUrl may itself be unknown pre-token. Order: if a `joinToken` (env/config) or a
     hubUrl+existing-creds already resolve, skip. Else prompt for **join token** (it embeds
     hubUrl+cert → single paste unlocks first contact).
   - **allowedRoots**: if empty in env+config, prompt (default `<cwd>`). Persist as array.
   - **runnerName**: optional; prompt with default = `hostname()` (Enter accepts). Only
     persist if user typed something other than the default (avoid pinning hostname).
3. Build patch, summary, confirm, `updateSlayzoneConfig`, seed `process.env`.
4. Fall through to the EXISTING `loadRunnerConfig()` → `startRunner()`. If the user still
   declined to give a token/hubUrl, `loadRunnerConfig` throws its current usage error —
   unchanged fail path.

Credential-store short-circuit detail: to avoid prompting a runner that already enrolled,
resolve hubUrl first (env/config/none). If creds exist for that host → no token prompt.

## Hub wiring (`packages/apps/hub/src/bin.ts` + `standalone-config.ts`)
Hub never hard-fails. Prompt only for **recommended** values that materially improve a
remote deploy, and only when interactive + not already set:
- **publicUrl** (`SLAYZONE_HUB_PUBLIC_URL`): if unset, prompt (default = empty → skip,
  loopback token). This is the one that actually matters for remote runners (token URL
  host). Explain in the prompt one-liner.
- **port** (`SLAYZONE_PORT`): prompt with default = current default (empty = OS/default).
- **runnerTransportPort**: same, optional.

Call `runInteractiveConfig` at the very top of `bin.ts main()` BEFORE
`applyStandaloneHubConfig()` (which is the env-seeding step). Because the helper seeds
`process.env` for accepted values, `applyStandaloneHubConfig`'s `setIfUnset` sees them and
the rest of the pipeline is byte-identical. Runner-secret auto-gen stays where it is (never
prompted — it's a generated secret, not a user value).

## Tests
- `config-prompt.test.ts` (new, platform): drive with a fake readline (inject an
  `AsyncIterable`/line-feeder + capture writes). Assert: skips when `!isTTY`/supervised;
  applies defaults on empty; confirm Y persists via a temp `configPath`, N does not;
  summary masks secret-ish keys.
- Runner: extend `main.test.ts` or a new `bin-interactive.test.ts` — non-TTY path unchanged
  (existing tests already cover), + a TTY-simulated path collecting a token → writes config.
- Hub: `standalone-config.test.ts` stays green (helper is a no-op when values preset / not
  TTY). Add a case: preset `SLAYZONE_HUB_PUBLIC_URL` → no prompt, no write.
- `install-handshake.test.ts` MUST stay green untouched (piped stdio ⇒ not a TTY ⇒ helper
  no-op). This is the guardrail proving we didn't break the deploy path.

## Files
- NEW `packages/shared/platform/src/config-prompt.ts`
- NEW `packages/shared/platform/src/config-prompt.test.ts`
- EDIT `packages/shared/platform/package.json` — add `./config-prompt` export subpath
- EDIT `packages/apps/runner/src/bin.ts`
- EDIT `packages/apps/hub/src/bin.ts`
- (maybe) EDIT `scripts/publish-hub-runner.sh` READMEs — one line on first-run prompt

## Unresolved questions
None — see Decisions (locked) above.
