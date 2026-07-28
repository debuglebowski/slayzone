# Env scope manifest + spawn sanitize

Close the env-leak channel: one typed manifest tags every SlayZone env var by
scope; one `sanitize()` (derived from it, fails closed) runs at every
terminal-child spawn boundary. Separately, split the `SLAYZONE_HUB_URL` ws/http
name collision.

## 1. Verification of the audit (done — all confirmed)

Every spawn inherits full `process.env`. Confirmed leak boundaries + who lacks
sanitization:

| Boundary | File | Today |
|---|---|---|
| PTY cold + warm | `terminal/.../pty-manager.ts:1119` `buildBaseEnv` (warm via `spawnLoginShell`) | `{...process.env}`, no strip |
| Chat SDK | `terminal/.../chat-transport-manager.ts:1041` | `{...process.env,...opts.env}`, no strip |
| User `run` process | `processes/.../process-backend.ts:119` | `{...process.env}`, no strip |
| Runner pty | `runner/src/handlers/pty.ts:48` `buildEnv` | inherits all; **only** strips `SLAYZONE_HUB_TOKEN` + overlays hook url |
| Runner proc | `runner/src/handlers/proc.ts:58` `buildEnv` | inherits all, no strip |
| Runner git setup script | `runner/src/handlers/git.ts:161` | inherits all, no strip |
| Worktree git snapshot | `agent-turns/.../git-snapshot.ts:17` | inherits all, no strip |

Infra parents that must NOT be sanitized (they feed the hub/runner, which
sanitize at their own terminal boundary): `app/.../index.ts:2252` (sidecar),
`:679` (local runner), `sidecar-server-supervisor.ts:310`,
`local-runner-supervisor.ts:91`.

**HUB_URL collision confirmed.** Sole writer into a child env is
`index.ts:690` — local-runner supervisor sets `SLAYZONE_HUB_URL = minted.hubUrl`
(a `wss://…/runners` URL). That ws value rides the runner's `process.env` into
`buildEnv` → every runner-hosted terminal → `slay` reads it via
`cli/hub-config.ts:86,92` → `normalizeHubUrl` rejects non-http → `process.exit(1)`.
- runner reads it as ws(s): `runner/config.ts:42,190`, hard-errors on ws under
  pin/remote (`config.ts:209,220`).
- CLI reads it as http(s): `cli/hub-config.ts:46,94`, hard-exits otherwise.

Note: `sanitize()` stripping the infra hub var from terminal children is by
itself the fix (the CLI never legitimately needed an inherited hub url — remote
hub access goes via `hub.json`, not env). The §5 authority-only redesign
(`SLAYZONE_HUB_ADDRESS`, scheme from MODE) is the independent, defense-in-depth
correctness fix the task also asks for — it makes the misconfig unrepresentable
even where the var IS legitimately inherited (runner ← supervisor).

## 2. Scope tag per var

Scopes → child-terminal policy:
- **secret** — never in a terminal. STRIP.
- **infra** — SlayZone process wiring a terminal must not reinterpret. STRIP.
- **identity** — per-task/agent identity, injected PER SPAWN by the existing
  overlay (`buildMcpEnv`/`mcpEnv`). STRIP from the inherited base, overlay
  re-adds the correct value (a terminal for task B must never inherit task A's
  `SLAYZONE_TASK_ID`; a taskless shell must have it ABSENT, not stale).
- **global** — same for the whole app, safe to inherit as-is. KEEP.

sanitize(base) = keep non-SlayZone user vars (PATH/HOME/toolchains) + `global`;
strip `infra`+`secret`+`identity`+**any unmanifested `SLAYZONE_*`** (fail closed).

| Scope | Vars |
|---|---|
| **secret** (strip) | `SLAYZONE_HUB_TOKEN`, `SLAYZONE_HUB_AUTH_SECRET` (§7 Q2 — replaces `SLAYZONE_HUB_RUNNER_TRANSPORT_SECRET`; the `config.json` key stays `runnerTransportSecret`), `SLAYZONE_HUB_JOIN_TOKEN` (§7 Q1 — replaces `SLAYZONE_RUNNER_JOIN_TOKEN`, which is retired outright: unmanifested, no alias), `SLAYZONE_ALLOW_PLAINTEXT_CREDENTIALS` |
| **infra** (strip) | `SLAYZONE_HUB_ADDRESS`* (§5 — replaces `SLAYZONE_HUB_URL` **+ `_HOST` + `_PORT`**), `SLAYZONE_HUB_PUBLIC_ADDRESS` (§5 — replaces `SLAYZONE_HUB_PUBLIC_URL`), `SLAYZONE_DESKTOP_BRIDGE_ADDRESS` (§2+§5 — replaces `SLAYZONE_BRIDGE_URL`), `SLAYZONE_MODE`, `SLAYZONE_SUPERVISED`, `SLAYZONE_DB_PATH`, `SLAYZONE_USER_DATA_DIR`, `SLAYZONE_SIDECAR_HOT_RESTART`, `SLAYZONE_BOOT_LOG_PATH`, `SLAYZONE_DEBUG_BOOT`, `SLAYZONE_*_SETTINGS_PATH`/`*_HOOKS_PATH`/`*_PLUGIN_PATH` (claude/gemini/codex/antigravity/opencode), `SLAYZONE_E2E_ALLOW_RUNNER`, `SLAYZONE_E2E_INSTALL_HOOKS`, `SLAYZONE_REGISTER_DEV_PROTOCOL`, `SLAYZONE_NONINTERACTIVE` + non-prefixed infra: `ELECTRON_RUN_AS_NODE`, `NODE_PATH`, `PLAYWRIGHT` |
| **identity** (strip base, overlay re-adds) | `SLAYZONE_TASK_ID`, `SLAYZONE_PROJECT_ID`, `SLAYZONE_SESSION_ID`, `SLAYZONE_AGENT_ID`, `SLAYZONE_AGENT_HOOK_URL`, `SLAYZONE_AGENT_HOOK_CONTEXT` (§3 — replaces `SLAYZONE_HOOK_CONTEXT`; sibling of `_AGENT_HOOK_URL`) |
| **global** (keep) | `SLAYZONE_RELEASE_CHANNEL`, `SLAYZONE_ROOT`, `SLAYZONE_DEV` |

Retired names (`SLAYZONE_HUB_URL`, `_HUB_HOST`, `_HUB_PORT`, `_HUB_PUBLIC_URL`,
`SLAYZONE_HOOK_CONTEXT`) are deliberately NOT listed: unmanifested `SLAYZONE_*`
fails closed, so a stale value in an ambient env is stripped at every spawn
without an entry. `SLAYZONE_HOOK_CONTEXT` is still READ by `notify.sh` v4 as a
back-compat fallback, but that value always arrives via an older release
channel's app's own per-spawn overlay (applied AFTER sanitize) — never by
inheritance, so it needs no manifest entry either. The only
place they still appear by name is `mcp-env.test.ts`'s `HUB_ENV_KEYS`, which pins
them ON PURPOSE so a future rename can't silently disarm the "no hub var reaches
a terminal" guard.

Not in manifest (compile-time `define` `__…__`, JS const, comment marker,
retired/test-only): `SLAYZONE_PROFILE`/`_CHROMIUM_PROD`/`_REACT_DEV` (build),
`SLAYZONE_HOOK_NAME` (const), `SLAYZONE_NOTIFY_VERSION` (script comment),
`SLAYZONE_STORE_DIR`/`_DB_DIR`/`_AGENT_MODE`/`_RUNNER_CONFIG`/
`_RUNNER_TRANSPORT_BASE_URL`/`_RUNNER_ALLOWED_ROOTS`/`_RUNNER_NAME`/
`_RUNNER_CREDENTIALS_DIR`/`_SEED_DEMO` (retired/inert/orphaned). Chromium-shell
`run.sh`-only vars stay script-scoped.

INSTALL-IDENTITY note (`SLAYZONE_ROOT` + `SLAYZONE_DEV`): both are `global`, not
`infra`/`identity`. They name WHICH install a process tree belongs to — ROOT the
on-disk anchor dir, DEV the DB filename inside it (`slayzone{.dev}.sqlite`) — and
the `slay` CLI derives its DB from BOTH (`apps/cli/src/db.ts` `getDbPath` +
`getStorageDir`). A child must resolve the SAME install as its parent, so they
inherit verbatim. Neither is a credential and neither can be reinterpreted as a
different KIND of target (the `SLAYZONE_HUB_URL` failure mode), so keeping them
costs nothing. Stripping them was a real break, caught in review:

  - `DEV` — a bare `slay <cmd>` in a dev-app task terminal exited 1
    (`Database not found: …/slayzone.sqlite … Re-run with --dev`), since the CLI
    fell back to the prod DB filename, which doesn't exist on a dev machine.
  - `ROOT` — no overlay covers it. `buildMcpEnv` sets it only inside
    `setHookIdentity()`, gated on a hook-capable agent mode, so a plain
    `terminal` PTY, a non-hook agent (cursor/copilot/qwen), and a pre-warmed pool
    spawn all get nothing → fallback `$HOME/.slayzone`. Identical on a dev box
    (invisible), but under an isolated e2e ROOT a child `slay` escapes the
    sandbox onto the real DB — the storage-migration failure class.

Both are pinned by survival checks in `env-manifest.test.ts`.

## 3. The manifest (single source of truth)

New lean leaf `packages/shared/platform/src/env-manifest.ts` (node builtins only,
like `slayzone-mode.ts`, so the runner bundle imports it without the
better-sqlite3 barrel). New export subpath `@slayzone/platform/env-manifest`.

```ts
export type EnvScope = 'global' | 'infra' | 'secret' | 'identity'
export const ENV_MANIFEST: Record<string, EnvScope> = { /* §2 */ }
/** Non-prefixed infra keys also stripped. */
export const NON_PREFIXED_INFRA = new Set(['ELECTRON_RUN_AS_NODE','NODE_PATH','PLAYWRIGHT'])

/** Strip infra+secret+identity+unmanifested SLAYZONE_* and NON_PREFIXED_INFRA.
 *  Keep user env + global. Overlay per-spawn identity AFTER this. */
export function sanitizeSpawnEnv(base: NodeJS.ProcessEnv): Record<string,string> {
  const out: Record<string,string> = {}
  for (const [k,v] of Object.entries(base)) {
    if (typeof v !== 'string') continue
    if (NON_PREFIXED_INFRA.has(k)) continue
    if (k.startsWith('SLAYZONE_')) {
      if (ENV_MANIFEST[k] === 'global') out[k] = v   // unmanifested → dropped (fail closed)
      continue
    }
    out[k] = v
  }
  return out
}
```

Fail-closed proof: a new secret added to `ENV_MANIFEST` is stripped
automatically; a new `SLAYZONE_*` var NOT yet manifested is also stripped (safe)
— only an explicit `global` tag lets one through.

## 4. Apply sanitize at every terminal-child boundary

Each site replaces its raw `{...process.env}` with `sanitizeSpawnEnv(process.env)`,
keeping its existing per-spawn overlay applied AFTER (so identity/adapter/mcp env
still lands correctly):

1. `pty-manager.ts` `buildBaseEnv` → `{ ...sanitizeSpawnEnv(process.env), USER, HOME, TERM… }`. Covers cold + warm (`spawnLoginShell`) + docker/ssh base.
2. `chat-transport-manager.ts:1041` → `{ ...sanitizeSpawnEnv(process.env), ...opts.env }`.
3. `process-backend.ts:119` → seed from `sanitizeSpawnEnv(process.env)`, then PATH-enrich + `spec.env`.
4. `runner/handlers/pty.ts` `buildEnv` → base = `sanitizeSpawnEnv(process.env)`; keep the hook-url overlay; drop the now-redundant explicit `delete SLAYZONE_HUB_TOKEN` (manifest strips it).
5. `runner/handlers/proc.ts` `buildEnv` → same base.
6. `runner/handlers/git.ts:161` (setup script) → same base + the `WORKTREE_PATH`/`REPO_PATH`/`SOURCE_BRANCH` overlay.
7. `agent-turns/git-snapshot.ts:17` → `{ ...sanitizeSpawnEnv(process.env), ...env }`.

Infra spawns (§1 parents) untouched — they must forward infra/secret downstream.

## 5. Fix the `SLAYZONE_HUB_URL` collision (authority-only `SLAYZONE_HUB_ADDRESS`)

Root cause is that ONE env var carried BOTH scheme+path AND the authority, so two
consumers disagreed on scheme. Fix: strip scheme+path out of the env channel
entirely. Replace `SLAYZONE_HUB_URL` with **`SLAYZONE_HUB_ADDRESS`** carrying ONLY
the hub authority — **`host[:port]`, no scheme, no path** (`ADDRESS` not `DOMAIN`:
loopback needs a port). Scheme is NEVER stored; each consumer DERIVES it from `SLAYZONE_MODE`
(`local`→`ws`/`http`, `remote`→`wss`/`https`) and appends its own path. A
ws-in-remote-mode value becomes unrepresentable, so the `exit(1)` collision
cannot occur.

As built this went further than the section originally planned — the same var also
became the hub's BIND channel (Q2) and `_PUBLIC_URL` became `_PUBLIC_ADDRESS` (Q4),
so **2 vars replace 3**. See the reversed Q2/Q4 below.

Compose helper (lean leaf `platform/src/hub-addr.ts`, subpath
`@slayzone/platform/hub-addr`, so the runner bundle imports it without the
barrel; reuses `getSlayzoneMode`):
```ts
// remote → secure scheme; local → plaintext. kind picks ws-family vs http-family.
export function hubUrlFromAddr(addr: string, kind: 'ws' | 'http', path = ''): string {
  const secure = getSlayzoneMode() === 'remote'
  const scheme = kind === 'ws' ? (secure ? 'wss' : 'ws') : (secure ? 'https' : 'http')
  return `${scheme}://${addr}${path}`   // addr = host[:port], never a scheme
}
```

**Q1 — both consumers derive scheme from MODE.**
- Runner (`runner/config.ts`): DOES read `SLAYZONE_MODE` today (`:220`, remote+ws
  hard-error). Change `ENV_VARS.hubUrl` to read `SLAYZONE_HUB_ADDRESS`, then build
  `hubUrlFromAddr(addr,'ws','/runners')`. The remote+ws guard becomes dead
  (unrepresentable) — replace with a clarifying comment; keep the `assertModeHostConsistency`-style checks.
- CLI (`cli/hub-config.ts`): does NOT read MODE today (verified). ADD it — CLI
  already deps `@slayzone/platform`. `resolveHubTarget` reads `SLAYZONE_HUB_ADDRESS`
  and builds `hubUrlFromAddr(addr,'http')` as `baseUrl`. `SLAYZONE_HUB_TOKEN`
  semantics unchanged. `hub.json` `url` (full URL, written by `slay hub set-url`)
  stays a full URL — an operator pointing the CLI at an external hub gives a
  complete URL; ADDRESS is only the SlayZone-injected env channel. So precedence
  becomes: `SLAYZONE_HUB_ADDRESS`(+MODE) > `hub.json` full url > local port
  discovery.

**Q2 — REVERSED (as built): ONE var for bind AND dial.** The plan first kept the
hub's bind vars (`SLAYZONE_HUB_HOST`/`_PORT`) separate from a dial-side ADDRESS.
Built the other way: `SLAYZONE_HUB_ADDRESS` is ONE concept — "the hub's address" —
and the value legitimately differs by which app holds it:
- the hub **BINDS** it → `parseHubAddress()` → `{host, port}` for `listen()`
- the runner / `slay` **CONNECT** to it → `hubUrlFromAddr()` → a full URL

Two roles under one name is not a collision here, because the *reason* the old
`HUB_URL` broke was a **scheme** disagreement between readers of the SAME value —
not two processes holding different values. `sanitizeSpawnEnv` strips the var
(infra) at every terminal-spawn boundary, so one role's value can never bleed into
the other's. Net: 3 vars (`_HOST` + `_PORT` + `_URL`) collapse to 1.

**Q3 — the CLI's local fast-path is GONE, not coexisting.** `cli/db.ts` no longer
fast-paths a port out of env: `getServerPort()` reads `settings.server_port` from
the DB, and the address env is consulted only through `resolveHubTarget()`. A
`loopbackHubPort()` gate guards the one remaining overlap — every `getServerPort()`
caller dials `127.0.0.1`, so a NON-loopback `SLAYZONE_HUB_ADDRESS` must not be
mistaken for the local app's port. Capability note: a terminal can no longer be
handed a hub port via env at all; `43-mcp-server.spec.ts` was inverted to assert
the ABSENCE (`SZADDR_UNSET`) and `60-cli.spec.ts` proves `slay` still works from
the DB with no address env.

**Q4 — REVERSED (as built): `SLAYZONE_HUB_PUBLIC_ADDRESS`, authority-only too.**
The plan kept `_PUBLIC_URL` as a full URL because no consumer reinterprets it.
Built as an address instead: a stored scheme there is *dead weight* (remote mode
already forces `wss`/`https`, and the path is always forced to `/runners`), and
one grammar for both address vars is the simpler invariant. Semantics: hub-only,
authority-only, the address the hub **writes into join tokens** — needed alongside
the bind address only when the two differ (reverse proxy / NAT).
`deriveRunnerHubUrl({publicAddress})` now returns `null` for anything that is not a
bare authority, so a scheme or a path is a hard reject rather than a silent
normalize.

**Port grammar (as built).** A bare host = "port unspecified". Bind side → the OS
assigns (`port === undefined`, callers default to 0); an explicit `:0` says the
same outright. Dial side → the scheme's default port stays implicit (the normal
published-DNS / reverse-proxy shape). IPv6 must be bracketed in the authority
(`[::1]:8080`); `parseHubAddress` returns it UNBRACKETED for `listen()`.

Edits (as built):
- New `platform/src/hub-addr.ts` + subpath export + unit test: `hubUrlFromAddr`, `isBareAuthority`, `parseHubAddress`, `LOOPBACK_HOSTS`. `hubUrlFromAddr` takes an explicit `mode` param (default `getSlayzoneMode()`) so a test passing its own env stays hermetic.
- `runner/config.ts`: `ENV_VARS.hubAddress` = `SLAYZONE_HUB_ADDRESS`; resolve via `hubUrlFromAddr(addr,'ws','/runners',mode)`. The remote+ws guard STAYS (now unreachable from env, still live for the config.json / join-token full-url paths).
- CLI `hub-config.ts`: `SLAYZONE_HUB_ADDRESS` + MODE → `hubUrlFromAddr(addr,'http')`; `hub.json` full-url + token behavior unchanged. `cli/db.ts`: `loopbackHubPort()` gate.
- Hub bind side (`paths.ts`, `hub/src/server.ts`, `standalone-config.ts`, `bin.ts`): read `SLAYZONE_HUB_ADDRESS` via `parseHubAddress`. Legacy `config.json` `port`/`publicUrl` keys are still READ (existing files keep booting) and never written.
- `hub/src/runner-listener.ts` + `remote-mcp-env-provider.ts`: `publicAddress` (authority) instead of `publicUrl`.
- `index.ts` writer: extract the mint's authority (`new URL(minted.hubUrl).host`) into `SLAYZONE_HUB_ADDRESS`. Mint response shape unchanged.
- Docs/scripts/e2e swept off the retired names: `local-runner-supervisor.ts`, `110-runner-loopback.spec.ts`, `112-multi-hub-federation.spec.ts`, `fixtures/electron.ts`, `43-mcp-server.spec.ts` (inverted), `60-cli.spec.ts`, `cli/test/*`, `install-handshake.test.ts`, `standalone-smoke.mts`, `window-api-shim/server-url.ts`, `transport/.../join-token.ts`, `scripts/chromium/run.sh` (+ both deeplink scripts + READMEs), `scripts/publish-hub-runner.sh`, `CLAUDE.md` §Env Var Naming (rules 4+5 added).
- join-token embedded `hubUrl` + config.json `hubUrl` key: internal, full-url, unchanged (fallbacks when no env ADDRESS).
- `slayzone-config.ts`: new `address` / `publicAddress` keys; `port` / `publicUrl` marked `@deprecated` and READ-only. `slayzone-config.test.ts` covers all four (it still asserted `runnerTransportPort`, a key `6b57c0a98` had already deleted — a pre-existing red, hidden because the platform tsconfig excludes `*.test.ts`).

Result: the env channel carries authority only; scheme is a pure function of
MODE at each consumer. Sanitize strips ADDRESS from terminals regardless, so both
the rename AND the strip independently close the leak.

## 6. Implementation sequence (TDD — failing test first each step)

1. **Manifest + sanitize** — write `env-manifest.test.ts` (strips a secret, keeps `PATH`, strips unknown `SLAYZONE_FOO`, keeps `global`, strips `ELECTRON_RUN_AS_NODE`) → RED → implement `env-manifest.ts` + subpath export → GREEN.
2. **Runner pty boundary** — extend `runner/handlers/pty.test.ts` (already spawns `env`): assert an injected `SLAYZONE_HUB_ADDRESS`/`SLAYZONE_HUB_TOKEN`/`ELECTRON_RUN_AS_NODE` is ABSENT in child, `PATH` present, hook-url overlay still applied → RED → route `buildEnv` through sanitize.
3. **Runner proc + git** — mirror boundary tests → RED → apply.
4. **PTY manager + warm + chat + process-backend + git-snapshot** — unit/e2e asserting no infra/secret leak, identity overlay intact → RED → apply.
5. **HUB_ADDRESS migration** — `hub-addr.test.ts` (local→ws/http, remote→wss/https, path append) → RED → `hub-addr.ts`. Then `runner/config` test reads `SLAYZONE_HUB_ADDRESS`+MODE→`ws(s)://addr/runners`; CLI `hub.test.ts` gains a `SLAYZONE_HUB_ADDRESS`+MODE→`http(s)://addr` case (keep the `hub.json` full-url cases); update `index.ts:690` writer (authority extract) + e2e → GREEN.
6. `pnpm typecheck` + affected package tests + relevant e2e (`110-runner-loopback`, terminal/runner specs).

## 7. Resolved decisions + open questions

Resolved (this round): Q1 CLI must add MODE-read (verified absent today). Prior:
identity = strip+overlay-readd; global = only RELEASE_CHANNEL; env-only (no
config.json key rename); PLAYWRIGHT safe to strip (all readers are server-side,
none in-terminal — verified); drop the explicit `delete SLAYZONE_HUB_TOKEN`
(manifest covers it).

Reversed during implementation (user-approved): **Q2** — bind and dial share ONE
`SLAYZONE_HUB_ADDRESS` (was: keep bind vars separate). **Q3** — the CLI's env port
fast-path is REMOVED, not coexisting; a `loopbackHubPort()` gate replaces it.
**Q4** — `_PUBLIC_URL` → `_PUBLIC_ADDRESS`, authority-only (was: keep as full URL).

Resolved: CLI `hub.json` `url` stays a FULL url — it is operator-written
(`slay hub set-url`) and points at an external hub, not an env channel, so no
migration.

Resolved (later round, LANDED): **Q1** — `SLAYZONE_RUNNER_JOIN_TOKEN` →
`SLAYZONE_HUB_JOIN_TOKEN`. Deciding fact: `mintJoinToken` binds the token to NO
runner (`runner_id` NULL until redemption) and its payload is entirely hub
identity (hub url + hub cert fingerprint + a secret verified against the hub's
`join_tokens` row), so the old name described its CONSUMER — the one thing rule 2
forbids. `_TOKEN`/`HUB_` per rule 3, matching the domain term used at every other
layer (`szjt1.`, `join_tokens`, `mintJoinToken`, `POST /api/runners/join-token`);
`ENROLL` was rejected for drifting from that term. The near-collision with
`SLAYZONE_HUB_TOKEN` (CLI→hub REST bearer) was accepted: different processes read
them, both are `secret` scope, and a mix-up fails closed on a missing required
var. The old name is RETIRED outright — no read-only alias. The first landing kept
one on a "published operator contract" premise that was simply false: the
published runner betas (`@slayzone/runner` 0.36.0-beta.2/3) read
`SLAYZONE_JOIN_TOKEN`, and `SLAYZONE_RUNNER_JOIN_TOKEN` only ever existed on
unreleased main (introduced in `0156d82b5`, which no `v0.36.0-beta.*` tag
contains), so no operator env anywhere carries it. It is therefore unmanifested
(fail-closed default strips it) and `loadRunnerConfig` ignores it, matching the
six OTHER names those same betas did ship and that this sweep dropped cold
(`SLAYZONE_HUB_URL`, `SLAYZONE_HUB_CERT_SHA256`, `SLAYZONE_JOIN_TOKEN`,
`SLAYZONE_RUNNER_ALLOWED_ROOTS`, `SLAYZONE_RUNNER_CREDENTIALS_DIR`,
`SLAYZONE_HOME_DIR`). General rule for this pre-1.0 sweep: nothing shipped ⇒ no
aliases.

Resolved (later round, LANDED): **Q2** — `SLAYZONE_HUB_RUNNER_TRANSPORT_SECRET` →
`SLAYZONE_HUB_AUTH_SECRET`. Deciding fact: the secret is the HMAC signing key for
ALL of hub-auth — better-auth's session/cookie signer AND the runner enroll/
api-key credentials (`createHubAuth({secret})`) — so `RUNNER_TRANSPORT` named just
ONE consumer, again the thing rule 2 forbids. `HUB_AUTH` matches the consuming
package (`@slayzone/hub-auth`); `_SECRET` retained per rule 3 (a key you HOLD and
sign with, vs `_TOKEN` = a bearer you PRESENT). Rejected: `HUB_SIGNING_SECRET`
(names the mechanism, not the domain — same class of miss) and `HUB_SECRET` (too
vague beside `SLAYZONE_HUB_TOKEN`). Scope deliberately limited to the env channel
+ JS identifiers (`DEV_HUB_AUTH_SECRET`, `ensureHubAuthSecret`, `hubAuthSecret`):
the **`config.json` key stays `runnerTransportSecret`**, because renaming it would
make every existing standalone install see no secret, generate a fresh one, and
invalidate the credentials of already-enrolled runners. The dev constant's VALUE
(`'slayzone-dev-runner-secret'`) is likewise unchanged so a supervised dev boot
keeps verifying its own existing sessions. No back-compat env alias (unlike Q1):
the old name's only non-test setters were three STALE refs in
`publish-hub-runner.sh`, fixed in the same change — one of them had the var in the
smoke test's `-u` scrub list, so the REAL name was never being scrubbed.

Open (naming, out of this plan's scope — raise separately):
1. `PLAYWRIGHT` → `SLAYZONE_E2E`? (unprefixed, and it is our own flag)
2. `SLAYZONE_HUB_TOKEN` → `SLAYZONE_HUB_API_TOKEN`? (it is the CLI's bearer for the hub's REST API; sharpening the vaguer name is the cheaper way to de-confuse the `HUB_TOKEN`/`HUB_JOIN_TOKEN` pair)
4. Prefixing `WORKTREE_PATH`/`REPO_PATH`/`SOURCE_BRANCH` — ⚠️ breaks the `.slay/worktree-setup.sh` user contract — and `POSTHOG_*`.
