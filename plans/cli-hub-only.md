# Make `slay` hub-only — no SQLite, no on-disk root

## Goal

Every `slay` operation goes to a hub over REST. The CLI never opens a DB file and
never derives the storage layout. Identical behaviour in a laptop shell, an agent
terminal, and a hub-only box with no app installed.

## Verified state (2026-08-05) — corrections to the brief

The brief's picture is mostly right but **overstates what is left**. Re-verified:

| Brief says | Actual |
|---|---|
| Direct DB consumers: `done.ts`, `artifacts.ts`, `hub.ts`, `index.ts` | `done.ts` is **already fully migrated** (`POST /api/tasks/:id/done`, `--close` rides the same request). `open.ts` too. |
| — | The **only** surviving `openDb()` caller in the whole CLI is `artifacts.ts:716` → `slay tasks artifacts path`. |
| — | `hub.ts` / `index.ts` don't read domain data — only `hasLocalDatabase()` + `getServerPort()` to feed `extraPorts` into discovery. |
| — | `db-helpers.mts`'s `resolveProject` / `resolveProjectByPath` are **dead exports** — zero callers (`init.ts` moved to `GET /api/projects/resolve-by-path`). `resolveProjectArg` reads flag + `$SLAYZONE_PROJECT_ID` only, no DB. |

Confirmed as stated: `resolveTarget()` prefers the hub; `openDb()` `process.exit(1)`s
uncatchably; `hasLocalDatabase()` exists for hub-only boxes; `getAlternateServerPort()`
serves only the `--dev` hint; `getDataDir()` anchors `cli-hub-target.json` +
`<kind>-runtime`; `getArtifactsDir()` reads local FS; `discoverHubs()` sweeps loopback.

So the real remaining surface is **four** things, not a broad migration:

1. `getServerPort()` in `api.ts` — the port lookup on every command.
2. `extraPorts` in `hub.ts` / `index.ts` — same lookup, for discovery.
3. `artifacts path` — the last true domain-data DB read.
4. `getDataDir()` for CLI-owned state files.

## Port numbering (decided — unchanged)

Keep today's constants exactly as `platform/src/paths.ts` already declares them:

| Range | Who | How |
|---|---|---|
| **51100–51109** | supervised sidecars (`SIDECAR_FIXED_PORT`) | fixed: **prod 51100, dev 51101, test 51102**; 51103–51109 spare |
| 51110–51199 | standalone hubs (`HUB_DYNAMIC_PORT_RANGE`) | first free |
| 51100–51199 | both, as one swept block (`HUB_PORT_BLOCK`) | discovery sweeps this |

**No renumbering.** The reserved head already exists and already sits inside the
swept block, so discovery stays a **single range** — no two-range sweep, no
`extraPorts`, no new constant. Stage 1 is purely the missing wire.

Considered and rejected: moving the sidecar to its own block (52000/1/2 or
50000/1/2). It buys nothing — a separate block would fall *outside*
`HUB_PORT_BLOCK`, forcing discovery to sweep two ranges to recover exactly the
visibility the current numbering already gives for free.

**Known, accepted:** the whole block sits inside every major OS's ephemeral range
(macOS 49152–65535, measured; Linux 32768–60999), so a bind can in principle lose a
race to an ephemeral socket. Live allocations on this machine reach 51013/51073 —
adjacent to the 51100 floor. Only a port below 32768 would remove this, which
inverts the `paths.ts:53` rationale (dynamic/private ⇒ no registered-service
collision). Pre-existing, unchanged by this plan, and the failure is loud
(`EADDRINUSE` at boot) rather than silent. Not addressed here.

## The crux: one unwired option

`SIDECAR_FIXED_PORT` (`platform/src/paths.ts:54`) is exported, barrel-listed, and
cited at length in `port-claim.ts`, `runner-listener.ts`, `server.ts` — and
**never wired**.
`sidecar-server-supervisor.ts:89` accepts `fixedPort?: number`; `main/index.ts:2420`
`startSidecarServer({…})` omits it, so `probeFreePort(host)` binds `0` → an OS
ephemeral port far outside `HUB_PORT_BLOCK` (51100–51199).

That single omission is the whole reason the DB is still on the port path:

```
sidecar on ephemeral port
  → discoverHubs() (sweeps the block) can't see it
    → hub.ts/index.ts need extraPorts from settings.server_port
      → they need openDb()
        → they need hasLocalDatabase() to dodge the uncatchable exit
and api.ts needs getServerPort() for every ordinary command
```

This is already an agreed, deferred follow-up —
`plans/hub-lifecycle-and-discovery.md:524`: *"Pass `SIDECAR_FIXED_PORT` as the app
supervisor's `fixedPort` so the app's hub binds inside the block and needs no
`extraPorts` special case. `fixedPort` is currently wired but only ever set by tests."*
Deferred because it "changes app boot". (No conflict with
`hub-single-mode-port.md:33`'s "Vestigial → delete" — that refers to the
`settings.runner_transport_port` persistence layer, and cites `SIDECAR_FIXED_PORT`
as the thing that *replaces* it.)

### Live evidence on this machine

A block sweep right now finds **zero** hubs, while the dev app is running:

```
sweep 51100-51199: 17.9ms / 10.6ms / 9.4ms — hubs found: 0
direct probe :51100/:51101/:51102 — 0.2ms each, nothing
```

The sidecars are at 50803 and 50820 — **two of them**, both `supervised: true`,
both `name: "app"`, both `root: ~/.slayzone`, both
`dbPath: ~/.slayzone/storage/slayzone.dev.sqlite`, both with a runner connected,
both ~7.7h uptime, different commits (`b7dc8e450-dirty` vs `cc792ea7c`).

Two live supervised sidecars writing one SQLite file is exactly the silent
ambiguity the fixed port was designed to make impossible — only one process can
bind 51101, so a second fails loud with `EADDRINUSE` instead of coexisting. Today
the DB read is what disambiguates them (`claimServerPort`'s non-clobber guard picks
a winner); nothing surfaces the loser.

Also confirms the reported symptom exactly: live DB is
`~/.slayzone/storage/slayzone.dev.sqlite` (398 MB), `~/.slayzone/dev/hub/` does not
exist yet, and a plain-shell CLI derives `~/.slayzone/slayzone.dev.sqlite` — one
level above. (Aside, not part of this plan: those two sidecars predate the
channel-scoped migration; an app restart will move the DB again.)

## Answers

### 1. Local hub discovery without the DB

**`discoverHubs()` alone is not sufficient — but it doesn't have to be.** Wire
`fixedPort` and the port becomes a *known constant per channel*, so the common case
needs no sweep at all: one direct `GET /health` on `127.0.0.1:{51100|51101}`, picked
by `SLAYZONE_DEV` (already `global`-scoped, already inherited into every pty).

**Cost — measured, not assumed.** The sweep is cheaper than feared: **~10–18 ms**
(loopback refusals return immediately; the 300 ms timeout only bites on a port that
accepts and stays silent). A direct probe is **~0.2 ms**. So raw speed is *not* the
argument — 10 ms per `slay` call is acceptable. The arguments are:

- **Determinism.** One constant, one answer. The DB can name a *dead* port —
  `e2e/git/60-cli.spec.ts:535` seeds `server_port = '1'` precisely to test that. A
  bound TCP port cannot go stale.
- **Ambiguity is eliminated at the source**, not resolved at read time. See the two
  live sidecars above.
- **It deletes the DB from the path**, which is the actual goal.

**Several hubs.** `hub-request.ts` refuses to guess — right for `runner mint`
(minting on the wrong hub enrolls a runner where nobody looks). For *task* commands
that refusal is wrong-shaped, but it essentially never arises on the fixed-port
path. Resolution order for task commands:

1. `resolveHubTarget()` (`--hub`, env, `cli-hub-target.json`) — unchanged.
2. Direct probe of this channel's `SIDECAR_FIXED_PORT`. Answered ⇒ done.
3. Sweep. Exactly one ⇒ use it.
4. Several ⇒ prefer `supervised: true` whose `root` matches this channel.
5. Still ambiguous ⇒ the existing refusal, verbatim.

**Does the app need to publish its port elsewhere?** No — and that is the point. A
fixed port *is* the publication, with no file, no key, and nothing that can go stale.

### 2. Coverage gaps

The REST surface is already broad: **~110 routes** across tasks, projects, tags,
templates, automations, panels, processes, pty, sessions, tabs, artifacts, browser,
hub, runners. Nothing in the task/project/tag/template/automation/panel/process/
pty/tab/session families needs a new endpoint — that migration is *deleting a
fallback*, not adding routes.

Genuine gaps, complete list:

| Gap | Fix |
|---|---|
| `artifacts path` — composes `<ROOT>/artifacts/<taskId>/<id>-<title>` locally | Add `filePath` to the existing `GET /api/artifacts/:id` body. No new route; the hub knows its own root, and the path is genuinely a property of the artifact. |
| `getAlternateServerPort()` "app is running with/without --dev" hint | Probe the *other* channel's fixed port. Strictly better — today it reads a DB that may name a dead port; then it probes what is actually alive. |

Non-gaps worth naming so they aren't re-litigated: `download --type zip` already
works over REST (assembles locally, streaming each member in — `artifacts.ts:79`);
`--type pdf|png|html` already POST to export routes; `--hub app` name resolution
needs nothing once the sidecar is in-block (`/health` already reports `name` +
`supervised`).

### 3. Where the line is

**Rule to state explicitly and enforce:**

> The CLI may touch the local filesystem for things that describe **this machine**
> — processes, service units, log files, install dirs, the pointer to a hub. It may
> not touch the local filesystem for anything that describes **domain state** —
> tasks, projects, artifacts, or another hub's port.

The DB is domain state. `cli-hub-target.json` is machine state.

Stays local, deliberately:

- **All of `service.ts`** — `launchctl`/`systemctl`/`loginctl`, bundle resolution,
  the `npm install` prefix, log tailing. A hub cannot supervise a box it isn't on,
  and `slay hub start` exists to create a hub where none runs — there is nothing to
  ask.
- **`cli-hub-target.json`** — bootstrapping the hub pointer from the hub is circular.
- **`<kind>-runtime`** npm prefix — a machine-level install cache; the unit file
  bakes its absolute path.
- **`slay init`** (writes into the user's repo), **`completions`** (emits shell
  script), **`update`** (global npm/pnpm/bun install).
- **`artifacts path`** output — local *by meaning*. The hub supplies the string; the
  command is only valid against a co-located hub. `/health` already reports `root`,
  so the CLI can compare and refuse rather than print a lie for a remote hub. That is
  a behaviour *improvement*: today it silently prints a local path unrelated to the
  remote artifact.

Corollary that unlocks the "no on-disk root at all" goal: these files need *a* root,
but not the **hub's** root. Anchoring them to `getDataDir()` is what drags the whole
layout rule into the CLI. Re-anchor to a CLI-owned dir (stage 4).

### 4. Artifacts

**Already solved — no work.** Content crosses the wire as a stream in both
directions (`apiGetStream` / `apiPostStream` / `apiPutStream`, `duplex: 'half'`),
never as a JS string, precisely because an artifact can be a PNG or PDF and a string
hop would U+FFFD every invalid byte sequence (`api.ts:91-110`). Nothing buffers a
whole artifact — the stream is consumed straight to stdout or a file. Version history
is content-addressed hub-side; only presentation (table header, TTY-gated diff
colours) is client-side, correctly. The only artifact item left is `path` (§2).

### 5. Auth

**No change to the credential a plain shell needs, and no regression.**
`restAuthAction` (`rest-auth.ts:115`) gates on
`hubAuthRequired = isRemoteMode() && hubAuth != null`. A local/supervised hub leaves
that false → every request short-circuits to `allow`. Even on an *enforcing* hub,
`isLoopbackAddress()` → `allow`, explicitly so an enforcing hub stays byte-identical
for the desktop host, the supervised runner, and in-task `slay`. Zero-config local is
preserved exactly.

One honest note, not a regression: reading the DB required filesystem permission on a
0700-ish dir; dialling loopback requires only local connect. On a multi-user box that
is marginally wider — but the sidecar **already** serves the whole REST surface
unauthed on loopback, so this plan neither creates nor fixes it. If it ever matters,
the fix is a loopback-peer-uid check; out of scope.

### 6. Incrementality

Yes — five stages, each independently shippable, each leaving the tree green.

## Staged plan

### Stage 1 — Wire the fixed port  ✅ LANDED

No `paths.ts` constant change, no `hub-discovery.ts` change — the numbering and the
sweep were already right. What shipped:

- `main/index.ts`: `startSidecarServer({ …, fixedPort })`, keyed
  `app.isPackaged ? 'prod' : 'dev'` — the same bit the sidecar env uses for
  `SLAYZONE_DEV`, so the app and the CLI cannot disagree about which install they mean.
- `cli/src/local-hub.ts` (new): `probeFixedPort()` — one direct `/health` on the
  channel's constant, via `findHub(String(port))` (all-digits ⇒ probes that port
  directly, no sweep, and validates the body is hub-shaped so an unrelated service
  holding the port is rejected rather than dialled). DB-free and lean-leaf only, so
  it stays importable on a box with no database.
- `cli/src/api.ts`: `resolveTarget()` is now async — `(await probeFixedPort()) ??
  getServerPort()`. Four call sites gained an `await`; all were already async.
- `cli/src/db.ts`: `notifyApp()` follows the same order.
- `platform/package.json`: added the `./paths` subpath export (paths.ts is lean —
  `node:fs` + `dirs` + `hub-addr`; `hub-discovery` already imported it).

**Design change found while implementing: Playwright is EXCLUDED from the fixed port.**
`paths.ts:44` claims e2e is safe on one fixed port because Playwright runs a single
worker — true *within* a group, but `e2e-parallel.sh` runs the full suite as one
process **per `e2e/` subdirectory**, i.e. **six concurrent Electron apps**. One fixed
test port would `EADDRINUSE` five of them. So `fixedPort` is `undefined` under
`isPlaywright`, and e2e keeps the OS-assigned port + the `settings.server_port`
channel. `SIDECAR_FIXED_PORT.test` is consequently unused by production code today.

*(Correction to an earlier draft of this plan: `runner-restart-survival.test.ts:89`'s
`HUB_PORT = 51102` is NOT a collision — it only feeds `deriveRunnerHubUrl`, a pure
URL builder, and never binds. Nothing to change.)*

**Verified**, not assumed:
- `pnpm typecheck` green across every package; `@slayzone/cli` builds and the
  constant is inlined in `dist/slay.js`.
- End-to-end with a **scrubbed env** (no `SLAYZONE_ROOT`) and **no database on disk**
  (`~/.slayzone/slayzone.dev.sqlite` genuinely absent — the reported breakage): a
  stub hub on 51101 served `slay tasks list`, which printed its row. The CLI reached
  it without deriving a storage path.
- Fallback intact: with 51101 empty, the same command falls through to the DB read
  and prints the unchanged `Database not found: …` message.
- Unit tests: `hub-port-block` 6/6, `hub-discovery` 16/16, `env-manifest` 42/42,
  `hub-lifecycle` 34/34, `runner-lifecycle` 20/20, `sidecar-server-supervisor` 14/14.

**Not yet in effect for a plain shell on this machine**: the running app is a
pre-change build on an ephemeral port. The probe only starts succeeding once the app
is restarted on this build.

### Stage 2 — Delete the DB from port discovery  ✅ LANDED

The e2e prerequisite resolved **better than the per-group-port sketch above**. Specs
already hold a handle to the app under test, so the fixture reads that app's actual
port back (`__serverPort`, the global the app already publishes) and `cliEnv()` pins
`SLAYZONE_HUB_ADDRESS` to it. No new env var, no `e2e-parallel.sh` change, no
manifest entry — and each spec targets its OWN app rather than a port assigned by
position.

**That pinning is a safety boundary, not a convenience.** With the DB path gone, an
unpinned `slay` in a spec would probe the fixed port and reach the DEVELOPER'S OWN
running SlayZone, writing test data into real tasks. `cliEnv()` therefore throws if
the port was never captured, rather than spawning the CLI unpinned.

- `e2e/fixtures/electron.ts`: capture the sidecar port at launch; `cliEnv()` pins it.
- `api.ts` / `db.ts`: `?? getServerPort()` tails deleted.
- `hub.ts` / `index.ts`: `outOfBlockPorts()` / `extraPorts` / `hasLocalDatabase()` gone.
- `getAlternateServerPort()` → `probeAlternateChannel()`, a `/health` probe of the
  other channel's fixed port. Strictly better than the DB read it replaces: a stored
  port can name a dead process, an answer proves one is alive.
- Two specs rewritten, because their premise was the DB:
  - *"UI updates when CLI discovers port from DB (production path)"* → **"…when CLI
    runs with no on-disk anchor at all"**: strips `SLAYZONE_ROOT` entirely and asserts
    create + notify still work. It asserted the opposite of the new invariant.
  - *"exits non-zero when app is not running"* → points at a dead address directly
    instead of seeding a throwaway ROOT with `settings.server_port = 1`.

### Stage 3 — Artifact path over REST; the DB layer deleted  ✅ LANDED

- `GET /api/artifacts/:id` now returns `filePath`, composed hub-side via the existing
  `resolveArtifactFilePath`. Only the hub knows its own storage root.
- `artifacts path` reads it, and refuses when the hub is not co-located
  (`isCoLocatedHub`) — previously it printed a local path for a remote artifact,
  silently and wrongly.
- Deleted: `openDb`, `getDbPath`, `defaultDir`, `getArtifactsDir`, `getDataDir`,
  `hasLocalDatabase`, `getServerPort`, `getAlternateServerPort`, the CLI's private
  `resolveArtifact` + `artifactFilePath`, the dead DB-backed `buildProviderConfig`,
  and the `node:sqlite` `ExperimentalWarning` suppression block (nothing left to warn
  about). **`node:sqlite` no longer appears in `dist/slay.js`.**

### Stage 4 — CLI-owned state  ✅ LANDED

New `cli-state.ts` owns the CLI's machine-local paths under `~/.slayzone/cli`:
`hub-target[.dev].json` (channel in the FILENAME, not a directory tree) and
`<kind>-runtime`. Anchored on `$HOME`, never on `SLAYZONE_ROOT`.

This also fixes a **latent bug**: `getDataDir()` resolved differently depending on
where `slay` ran — `~/.slayzone/cli-hub-target.json` from a shell, but
`~/.slayzone/<channel>/hub/cli-hub-target.json` inside an agent terminal. Same user,
same command, two different files. Both legacy locations are still READ (one-way
compat) and both are cleared by `hub logout` — deleting only the new path would leave
a pre-move file, complete with bearer token, for the fallback to resurrect.

### Stage 5 — Locked in  ✅ LANDED

- `scripts/check-server-electron-free.sh` (already wired into `pnpm lint`) gained a
  CLI guard: no `node:sqlite`, and no `getStorageDir`/`getSlayzoneHomeDir`/
  `getSupervisedRoot` anywhere in `apps/cli/src` except `cli-state.ts`. It caught a
  real leftover on first run (`db.ts` still importing `getStorageDir`).
- New `cli/src/local-hub.test.ts` (11 assertions, wired into `run-all.sh`) pins
  `fixedPortForChannel` and `isCoLocatedHub`.

**A bug the new test found and fixed:** WHATWG `URL.hostname` keeps the brackets on
an IPv6 literal (`[::1]`) while `LOOPBACK_HOSTS` stores the bare form, so an IPv6
loopback hub was classified as off-box and `artifacts path` would have refused a
genuinely local path.

### Stage 3 — Close the artifact-path gap

- Add `filePath` to `GET /api/artifacts/:id`.
- `artifacts path` uses it; compares `/health`'s `root` and refuses for a
  non-co-located hub instead of printing a misleading path.
- Delete `openDb`, `getArtifactsDir`, `getDbPath`, `defaultDir`, `hasLocalDatabase`,
  and the dead `resolveProject` / `resolveProjectByPath` from `db-helpers.mts`.
- Drop the `node:sqlite` import — which also deletes the `ExperimentalWarning`
  suppression block at `index.ts:1-13` and removes `node:sqlite` from the bundle.

**The CLI now opens no database.**

### Stage 4 — Re-anchor CLI-owned state

- `cli-hub-target.json` → `~/.slayzone/cli/hub-target[.dev].json`, keyed on
  `SLAYZONE_DEV` (which the CLI already reads) — a 1-line CLI-local rule, not a
  mirror of `getSupervisedRoot()`.
- `<kind>-runtime` → `~/.slayzone/cli/<kind>-runtime`. Preserves today's *effective*
  location (`getDataDir()` with ROOT unset is already `~/.slayzone`), minus the ROOT
  coupling.
- Read-time fallback to the old locations so an existing `hub use` / `hub login`
  survives.

This also fixes a **latent bug**: `getDataDir()` today resolves differently depending
on where `slay` runs — `~/.slayzone/cli-hub-target.json` from a plain shell,
`~/.slayzone/dev/hub/cli-hub-target.json` inside an agent terminal. Same user, same
command, two different files. A CLI-owned dir makes it one.

**The CLI now derives no on-disk layout.** `SLAYZONE_ROOT` becomes irrelevant to it.

### Stage 5 — Lock it in

- Lint/test rule: no `node:sqlite`, no `getStorageDir`/`getSlayzoneHomeDir` import in
  `apps/cli/src` outside the machine-state module. Fail closed, like `ENV_MANIFEST`.
- e2e: `slay tasks ls` from a scrubbed env (no `SLAYZONE_ROOT`, no `SLAYZONE_DEV`)
  against a running app.

## Final verification (all five stages)

- `pnpm typecheck` green across every package.
- `bash scripts/check-server-electron-free.sh` → "Server boundary guards passed."
- `@slayzone/cli` builds; `node:sqlite` / `DatabaseSync` appear **0 times** in
  `dist/slay.js`.
- Unit: local-hub 11/11, hub-lifecycle 34/34, runner-lifecycle 20/20,
  sidecar-server-supervisor 14/14, hub-discovery 16/16, hub-port-block 6/6,
  env-manifest 42/42, cli-author 2/2, update 29/29.
- E2E against a real built app: `60-cli.spec.ts` **58/58**, `34-cli-pty-start`
  + `95-task-progress` **10/10**.
- Manual, scrubbed env with **no database on disk**: `tasks list` and
  `artifacts path` served by a stub hub; `artifacts path` refuses a non-loopback hub.

Known leftovers, deliberately out of scope: `db-helpers.mts`'s `resolveProject` /
`resolveProjectByPath` are production-dead but still test-covered (they take an
injected db interface and never open a file, so they do not violate the goal); a
pre-existing unused `folderPath` at `artifacts.ts:151` predates this work.

## Recommendation

**Skip the tactical fix. Go straight to stage 1.**

Teaching the CLI the new layout rule means a second copy of `getSupervisedRoot()` to
keep in sync forever — and it is *larger* than stage 1, which is one argument at one
call site plus a probe helper. Stage 1 removes the rule instead of duplicating it,
fixes the plain-shell breakage on the same day, closes the two-live-sidecars
ambiguity as a side effect, and is an already-agreed follow-up rather than a new
direction.

Stages 2–3 are then mostly deletion. Stage 4 is the only genuinely new design, and
it is small and independently valuable.

## Unresolved questions

1. Stage 1 changes app boot. Ship with stage 2, or land alone first and watch?
2. Two live pre-migration sidecars on this machine right now. Restart the app before
   starting, or leave as a test case?
3. `artifacts path` against a remote hub — refuse, or print with a stderr warning?
4. Stage 4 fallback: read-only compat, or migrate-on-write (move the file)?
5. Standalone hub in CWD — does `~/.slayzone/cli/<kind>-runtime` violate the
   "no `~/.slayzone`, state in CWD" rule, or is a machine-level npm cache exempt?
6. Keep `--dev` as the channel selector for the fixed-port probe, or read
   `SLAYZONE_RELEASE_CHANNEL` (which `getSupervisedRoot` uses) for beta/stable?
