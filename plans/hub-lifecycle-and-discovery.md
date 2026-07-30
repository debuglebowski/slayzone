# Hub lifecycle + multi-hub discovery via `slay`

## Goal

Start a hub and walk away — it stays up across crashes and logins. List, stop and
inspect every hub on the machine. One control surface: the `slay` CLI. The hub
binary stays a plain foreground server.

Today: `npx @slayzone/hub` holds the terminal; the only way to detach is
`nohup … & disown`, the pid you background is npx's wrapper rather than the hub,
nothing restarts it if it dies, and there is no way to see which hubs run on the
box.

Target shape:

```
slay hub start                 # in this dir, supervised, name = dirname
slay hub ls
NAME      PORT   PID    ROOT            RUNNERS  UPTIME
main      51110  4821   ~/hubs/main     2        3d 4h
staging   51111  9134   ~/hubs/staging  0        12m
app       51101  2201   (desktop app)   1        1h
slay --hub staging tasks list
slay hub stop staging
```

## Decided

1. **`@slayzone/cli` goes public on npm.** Bin only (`slay`) — no `exports`/`main`
   in the published manifest, so no JS API is committed. Mirrors how the hub
   manifest is rewritten at publish time.
2. **Port block 51100–51199** reserved for hubs. Discovery = parallel `/health`
   probe of the block. No pidfile, no registry file.
3. **`slay hub start` npx-spawns** `@slayzone/hub` — no hard dependency, always
   gets the version the operator's registry resolves.
4. **Lifecycle stays OUT of the hub bin.** No `--detach` / `--stop` / `--status`
   flags. A self-daemonizing server means pidfile races, double-fork, own log
   rotation, and no crash-restart — the wrong shape. Foreground + stdout +
   external supervisor is correct, and the hub is already exactly that.
5. **`hub ls` lists ALL hubs**, including the desktop app's supervised sidecar,
   tagged as such. Discovery probes ports, so it finds every hub regardless of
   who started it; hiding one would make the list lie.
6. **`hub stop` refuses the supervised sidecar** — the desktop app owns its own
   lifecycle, and killing it breaks the running app. A rule, not a `--force`
   flag. Any other hub stops without ceremony.
7. **Reserve 51100–51109** as the supervised head of the block; standalone
   dynamic allocation starts at 51110.
8. **No separate "install a service" command.** `hub start` IS the supervised
   path: it registers the hub with the OS supervisor (launchd / systemd) and
   starts it. There is no reason to want a background hub that dies for good on
   the next crash — if you want the foreground, run the hub in the foreground.
   One background path, supervised by default.
9. **Rename the client-target trio** while the CLI is still unpublished:
   `set-url` → `use`, `status` → `current`, `logout` → `forget`. `status` collided
   with the new `ls`, and `logout` deletes a local file rather than logging out of
   anything. `use` also accepts a discovered hub NAME, not just a URL.

## Architecture

```
@slayzone/hub                     foreground server. /health grows identity
                                  fields. binds first-free port in the block.
                                  + SIGHUP → shutdown.
@slayzone/platform/hub-discovery  probe block → live hubs. No shared state.
@slayzone/platform/hub-service    write/remove a launchd plist or systemd unit.
@slayzone/cli                     slay hub ls|start|stop|restart|logs|use
                                  |current|forget + global --hub targeting
@slayzone/app                     consumes hub-discovery for the federation UI
```

Discovery is a **library**, not CLI code: multi-hub is a product concept
(`project_multi_hub_federation`), so the desktop app needs the same list and
cannot import from the CLI package.

It is a **platform subpath**, not a new package. `@slayzone/platform` is already
the shared layer and already has the pattern for exactly this shape — a
dependency-free leaf module exposed as its own import path so a lean bundle
resolves one file without pulling the SQLite-dependent barrel
(`@slayzone/platform/hub-addr`, `/slayzone-config`). Discovery depends on
`hub-addr` + `paths` + `node:http` and nothing else, so it sits beside them.

### Why `/health` probe, not pidfiles or proc-scan

- Pidfiles go stale; a dead process leaves a live-looking file. A bound TCP port
  cannot go stale (`port-claim.ts:9` already reasons this way).
- A registry file would need machine scope → violates the standalone-state-in-CWD
  rule, and still misses hubs started by systemd/docker/another user.
- Proc-scan (`/proc/<pid>/cwd`, `lsof`, `tasklist`) is per-OS and misses
  containers.
- A port probe is one code path on every OS, and catches docker-published hubs,
  other users' hubs, and the desktop app's own supervised sidecar for free.

Known limit: a hub bound to a single non-loopback interface (not `0.0.0.0`) is
not on loopback → not found by scan. Same for a port outside the block. Both are
explicitly-configured deployments; `slay hub use <url>` covers them.

### Why `start` supervises instead of bare-detaching

A bare detached spawn has nothing watching it: crash → gone until a human
notices; reboot → gone. The only reason to accept that would be "supervision is
heavyweight, make it opt-in" — but it isn't. Both OSes ship a supervisor that
takes a ~15-line declarative file, and writing that file is no harder than
assembling the spawn options we would otherwise need. So there is no audience for
the unsupervised background mode, and no second command.

What the OS gives us that we would otherwise reimplement: restart-on-exit with
backoff, start-at-login, stdout/stderr redirection, and a stable identity that
survives our own CLI exiting.

## Phase 1 — `/health` identity + gating

`packages/apps/hub/src/health.ts`

Add to `HealthState`: `name`, `root`, `pid`, `mode`, `supervised`,
`runnersConnected`. Response gains those fields.

**Gate every path/identity field on a loopback-origin request**
(`req.socket.remoteAddress` ∈ `LOOPBACK_HOSTS`). That covers the new `root` +
`pid` AND the existing `dbPath` (`health.ts:34`), which leaks an absolute FS path
to any caller today when the hub binds wider than loopback. Non-loopback callers
keep `ok`/`port`/`uptimeMs`/`commit`/`builtAt`/`buildId`.

`runnersConnected` comes from the runners registry the gateway already owns
(`server.ts:125`) — pass a getter into `HealthState`, no new bookkeeping.

## Phase 2 — hub name

New config key `hubName` in `SlayzoneConfig`
(`packages/shared/platform/src/slayzone-config.ts`), env channel
`SLAYZONE_HUB_NAME`, default `basename(SLAYZONE_ROOT)`. CWD-derived — no home
dir, no new state file.

Add `SLAYZONE_HUB_NAME` to `ENV_MANIFEST` (`platform/src/env-manifest.ts`);
`env-manifest.test.ts` fails otherwise.

Seeded in `applyStandaloneHubConfig` alongside the other keys
(`hub/src/standalone-config.ts:87`).

## Phase 3 — block port allocation

`packages/shared/platform/src/paths.ts`

```ts
export const HUB_PORT_BLOCK = { start: 51100, end: 51199 } as const
// 51100-51109 reserved head: SIDECAR_FIXED_PORT (supervised prod/dev/test)
// 51110-51199 standalone dynamic
export const HUB_DYNAMIC_PORT_RANGE = { start: 51110, end: 51199 } as const
```

`hub/src/server.ts:348` currently `cfg.port ?? getTrpcPort() ?? 0` — OS-assigned
when unspecified, so the hub lands outside the block and is undiscoverable.
Change the fallback from `0` to a sequential-bind walk over
`HUB_DYNAMIC_PORT_RANGE`: `listen`, on `EADDRINUSE` try the next, exhaust →
fail loud. An explicit `:0` in `SLAYZONE_HUB_ADDRESS` still means OS-assigned
(the grammar in `hub-addr.ts` says so) — honored, and such a hub is simply not
discoverable.

`SIDECAR_FIXED_PORT` values are unchanged; they just become the documented
reserved head of the block.

## Phase 4 — `@slayzone/platform/hub-discovery`

New leaf module `packages/shared/platform/src/hub-discovery.ts`, exported as its
own subpath. Imports `./hub-addr`, `./paths` and `node:http` only — nothing that
reaches better-sqlite3, so the CLI and runner bundles stay lean.

```ts
export interface DiscoveredHub {
  name: string; port: number; pid: number
  root: string; dbPath: string; mode: string
  buildId: string; commit: string; uptimeMs: number
  runnersConnected: number
  /** True when this is the desktop app's supervised sidecar (mode/env reported
   *  by /health). Listed like any other hub; `hub stop` refuses it. */
  supervised: boolean
}
export function discoverHubs(opts?: {
  range?: { start: number; end: number }   // default HUB_PORT_BLOCK
  timeoutMs?: number                        // default 300 (port-claim's value)
  concurrency?: number                      // default 32
}): Promise<DiscoveredHub[]>
export function findHub(nameOrPort: string): Promise<DiscoveredHub | null>
```

Probe = the `isPortAlive` shape from `port-claim.ts:22`, but parse the body.
100 ports × 300 ms with 32-way concurrency → sub-second.

Also probe the CLI's configured target (`hub.json` / `SLAYZONE_HUB_ADDRESS`) so
an out-of-block or remote hub still shows up, tagged as configured rather than
discovered.

`supervised` needs `/health` to say so — add it to the Phase 1 identity fields,
sourced from `SLAYZONE_SUPERVISED` (already the canonical flag).

## Phase 5 — `@slayzone/platform/hub-service`

The OS-supervisor backend behind `hub start` / `stop`. Second leaf module, same
lean-subpath rules as hub-discovery.

```ts
export type ServiceBackend = 'launchd' | 'systemd' | 'none'
export function detectBackend(): ServiceBackend
export function registerHub(spec: {
  name: string; root: string; port?: number
}): Promise<{ backend: ServiceBackend; unitPath?: string }>
export function unregisterHub(name: string): Promise<boolean>
export function listRegistered(): Promise<{ name: string; unitPath: string }[]>
```

**macOS (launchd).** Write `~/Library/LaunchAgents/com.slayzone.hub.<name>.plist`
with `ProgramArguments` = the resolved hub bin + args, `WorkingDirectory` = root,
`KeepAlive` = `{SuccessfulExit: false}` (restart on crash, not on a clean
`hub stop`), `RunAtLoad`, and `StandardOutPath`/`StandardErrorPath` into
`<root>/storage/logs/`. Register with `launchctl bootstrap gui/$UID <plist>`,
start with `launchctl kickstart`.

**Linux (systemd user).** Write `~/.config/systemd/user/slayzone-hub@<name>` — a
plain unit per hub, not a template, so `Environment=` can carry `SLAYZONE_ROOT`.
`Restart=on-failure`, `WorkingDirectory=`, journald captures stdout.
`systemctl --user daemon-reload && enable --now`. Also run
`loginctl enable-linger $USER` so the unit survives logout — automatic, no
operator step.

**Windows / no supervisor** → `detectBackend()` returns `'none'`; the caller falls
back to a bare detached spawn and says so on stdout.

Files land outside the hub root by necessity — launchd and systemd only read
their own directories. That is OS registration, not SlayZone state, so the
standalone-state-in-CWD rule is untouched (no SlayZone data leaves the root).

**Honest scope of "survives reboot":** a launchd *user agent* starts at LOGIN,
and a systemd user unit needs lingering (which we enable). A true pre-login
daemon needs `/Library/LaunchDaemons` or a system unit — root-owned, needs sudo.
Out of scope; a later `--system` flag can add it. `hub start` must print what it
actually guarantees ("restarts on crash; starts when you log in"), never
"survives reboot" unqualified.

**Resolving the hub command for the unit file.** The unit needs an absolute
command, and `npx` at boot means a network round-trip on every restart. So:
resolve `@slayzone/hub`'s bin path ONCE at `hub start` time (npx-install if
absent, then read the resolved path) and bake the absolute path + the resolved
version into the unit. Upgrading = `hub restart --upgrade`, which re-resolves.

## Phase 6 — `slay hub` commands

`packages/apps/cli/src/commands/hub.ts`. The three existing client-target
commands are renamed (Decision 9) — the CLI is unpublished, so no deprecation
shims:

| Command | Behavior |
|---|---|
| `hub ls` | table: name, port, pid, root, build, runners, uptime. Supervised sidecar shown with root `(desktop app)`. `--json` |
| `hub start [--name n] [--root d] [--port p]` | register with the OS supervisor + start; print name, addr, log path, and what the supervision actually guarantees |
| `hub stop <name\|port>` | stop AND unregister — desired-state, so there is no "registered but stopped" third state to explain. Falls back to SIGTERM-by-pid when the hub has no unit (started by docker/systemd-by-hand/etc). **Refuses when `supervised`** ("the desktop app owns this hub; quit the app instead") |
| `hub restart <name\|port> [--upgrade]` | supervisor restart; `--upgrade` re-resolves the hub version first. Same supervised refusal |
| `hub logs <name\|port> [-f] [-n N]` | tail `<root>/storage/logs/` (journald on systemd) |
| `hub use <name\|url> [--token t]` | was `set-url`. Accepts a discovered hub name or a full URL |
| `hub current` | was `status`. Which hub this CLI targets + `/health` probe |
| `hub forget` | was `logout`. Drop the stored target |

`hub ls` is the machine view ("what is running here"); `hub current` is the client
view ("which hub am I configured to talk to"). Two questions, two commands.

`hub start` details:

- Root = `--root` or CWD (matches the hub's own anchoring,
  `standalone-config.ts:76`). Name = `--name` or `basename(root)`.
- Pre-flight: `discoverHubs()`; refuse if a live hub already owns that root, or
  if the name is already registered with a different root.
- `registerHub()` (Phase 5), then wait for `/health` to answer — or for the
  supervisor to report the unit failed. A boot failure surfaces immediately
  instead of silently "starting".
- On `detectBackend() === 'none'`: bare detached spawn (`{detached: true,
  cwd: root, stdio: ['ignore', logFd, logFd]}` + `unref()`), and print that this
  hub will NOT restart on crash.

No `--fg` flag: running a hub in the foreground is `npx @slayzone/hub` — that IS
the hub binary's only mode, so a `slay` passthrough would add a wrapper and no
capability. `hub start` means "background, supervised", full stop.

## Phase 7 — global `--hub` targeting

Listing hubs you cannot talk to is half a feature. Add a root-level
`--hub <name|port>` option (`cli/src/index.ts`) resolved through
`findHub` in the existing `preAction` hook, seeding the target that
`resolveHubTarget()` returns (`cli/src/hub-config.ts`). Precedence becomes
`--hub > SLAYZONE_HUB_ADDRESS > hub.json > local app`.

## Phase 8 — publish `@slayzone/cli`

- Drop `private: true`; keep the repo manifest otherwise as-is.
- Extend the publish script to a third package. Published manifest: `bin: {slay:
  "./dist/slay.js"}`, `main` same, `engines: {node: ">=24"}`, **zero
  dependencies** — `build.mjs` already bundles everything with only `node:sqlite`
  external, so there is nothing to rebuild at install time (unlike hub/runner).
- No wrapper script in the published package: `dist/slay.js` already carries the
  `#!/usr/bin/env node` banner, and npm generates the Windows `.cmd` shim. The
  repo's `bin/slay` sh wrapper stays for the app-installed path
  (`platform/src/cli-install.ts`).
- The wrapper's `--no-warnings` is lost, so `node:sqlite`'s ExperimentalWarning
  could print. Suppress precisely at the top of `cli/src/index.ts`
  (`removeAllListeners('warning')` + a re-added filtered handler) rather than
  broadly.
- Rename `scripts/publish-hub-runner.sh` → `publish-npm.sh` and the workflow to
  match; the name is now wrong. Mechanical.
- Smoke: the existing script already boots the hub tarball directly in the
  background (`publish-hub-runner.sh`, the `$HPID` block). Extend it to
  clean-install the cli tarball under plain node and then run `slay hub ls`
  (must find that hub) → `slay hub stop` (must terminate it). This covers
  discovery + the no-unit SIGTERM fallback on published artifacts.
- Deliberately NOT the registering path: a publish smoke must not write a
  launchd/systemd unit onto the CI runner or a developer's machine. `hub start`
  registration is covered by Phase 5 content tests + one manual check per OS.

## Tests

| What | Where |
|---|---|
| health identity fields + loopback gating (incl. `dbPath`) | `hub/src/health.test.ts` (new) |
| block allocation: sequential bind, EADDRINUSE walk, exhaustion, `:0` honored | `hub/src/server` port test |
| discovery: N fake `/health` servers in a temp range, dead ports, malformed body, timeout | `platform/src/hub-discovery.test.ts` |
| plist/unit CONTENT is exact for a given spec; `detectBackend` per platform; `unregister` idempotent | `platform/src/hub-service.test.ts` — generate to a temp dir, never touch the real LaunchAgents/systemd dirs |
| `hub stop` refuses a `supervised: true` hub | cli hub-command test |
| `hubName` resolution env > config > basename(ROOT) | `standalone-config.test.ts` |
| `SLAYZONE_HUB_NAME` manifested | `env-manifest.test.ts` (existing assert) |
| ls → stop round-trip against two directly-spawned hubs in two temp roots (no OS registration) | new e2e-style script test |
| publish smoke (see Phase 8) | `scripts/publish-npm.sh` |

TDD: discovery + health tests first (`feedback_tdd`).

Automated tests never exercise real `launchctl bootstrap` / `systemctl --user
enable` — that would leave units behind on the machine running the suite. Unit
tests assert generated file content against a temp dir; the register/start path
gets one manual verification per OS.

## Out of scope / follow-ups

- Rename `storage/logs/sidecar.log` → `hub.log` (legacy name on a standalone
  hub). Behavior-preserving but touches the publish smoke comment.
- Making the CLI's DB access lazy so hub commands never open SQLite.
- Desktop app federation UI on top of `hub-discovery`.
- `hub start --system` (root-owned launchd daemon / systemd system unit) for
  genuine pre-login boot. Needs sudo; the user-level default covers dev + most
  servers.
- Windows service backend (`sc.exe` / a wrapper). Falls back to bare detached
  spawn until then.

## Amendment — command surface reworked after review

The single `hub start` this plan describes was split. Everything below still
describes the mechanism accurately; only the command NAMES changed, so read
"`hub start`" in the older sections as "`hub create`".

| Command | Does |
|---|---|
| `hub create <name>` | register + start. Name REQUIRED. Fails if that name exists |
| `hub start <name>` | start an existing stopped hub. No-op (not a restart) if running |
| `hub stop <name>` | stop, KEEP the registration |
| `hub rm <name>` | stop + remove the registration. Leaves the hub's data on disk |

Why, in the reviewer's terms:

- **A name is required.** It is how every other command addresses a hub, so
  defaulting it to the directory name made the identity implicit and let two hubs
  collide by accident.
- **`create` is the right verb.** It errors on a duplicate rather than being
  idempotent, so `up` (which promises "make it so, repeatedly") would have been a
  lie. `init` was rejected: it implies a separate start step that does not exist.
- **Duplicate detection now includes registered-but-STOPPED hubs**, by probing the
  unit file. The old running-only check would silently overwrite a stopped hub's
  unit — a real hole.
- **`start` is NOT an alias for `restart`.** They differ exactly on a running hub,
  where a restart drops connected runners and pty sessions; someone typing `start`
  means "make sure it is up". Aliasing would make a common typo destructive.
- **This reintroduces "registered but stopped"**, which an earlier decision
  removed. Unavoidable once `create`/`rm` own registration: `stop` then naturally
  keeps the unit. `hub registered` labels each hub `(running)`/`(stopped)` and
  prints the command to bring a stopped one back.

`start` checks RUNNING before it checks registration, so a hub that is up but has
no unit (docker, a hand-written unit) is reported as already running rather than
"no hub named …".

Also fixed while reworking: `restart --upgrade` rewrote the unit WITHOUT the
interpreter env, which would have turned a working unit into one that crash-loops
on Electron-ABI natives.

Verified end-to-end by hand: create → duplicate refused (running) → stop → still
refused (stopped) → `registered` shows `(stopped)` → start → start again is a
no-op with an unchanged pid → rm → plist gone, data preserved.

## Done

All eight phases landed. 141 assertions green across the touched suites
(hub-discovery 16, hub-service 19, hub-port-block 6, health 6, standalone-config
16, slayzone-config 14, env-manifest 42, build-info 4, port-claim 4, **cli
hub-lifecycle e2e 14**). `@slayzone/platform`, `@slayzone/hub` and `@slayzone/cli`
typecheck clean.

`packages/apps/cli/src/commands/hub-lifecycle.test.ts` is the end-to-end tier:
boots two REAL hubs in throwaway roots and drives `ls` / `--hub` / `stop` /
`restart` / `registered` through the BUILT CLI bundle. Registered in run-all.sh;
passes repeatedly and leaves no launchd unit, temp dir or stray process behind.
It spawns hubs directly rather than via `hub start`, so no service is ever
installed by the suite.

### Bug found by running `hub start` for real

`hub start` failed on EVERY machine with `Cannot find module
'@slayzone/hub/package.json'`. Two faults stacked:

1. The npx fallback `npx --package @slayzone/hub node -p
   "require.resolve('@slayzone/hub/package.json')"` can never work: npx puts the
   package's **bin** on PATH but does not add its cache to Node's **module
   resolution** paths. Verified directly — the command fails standalone.
2. In the monorepo the plain-resolver branch misses too, because `@slayzone/cli`
   does not declare `@slayzone/hub` as a dependency.

`resolveHubBin()` now resolves in three deterministic steps: Node's resolver → a
sibling `packages/apps/hub` in the dev tree → `npm install --prefix
<cli-state>/hub-runtime`, which lands at a stable absolute path (important: the
unit file references it on every restart). Both the dev-tree and the npm-install
branches are verified working.

### Bug found by writing the e2e test

`hub ls` **crashed on a machine with no SlayZone database** — i.e. the primary hub
deployment. `outOfBlockPorts()` called `getServerPort()` → `openDb()`, which
`process.exit(1)`s when the DB file is absent; the `try/catch` around it was inert
because an exit is not a throw. Fixed with a `hasLocalDatabase()` file probe
before the read (cli/src/db.ts), applied in both the hub command and the `--hub`
resolver. The first e2e case now pins it.

### Deviations from the plan

- **Two service-backend helpers, not one.** `hub-service.ts` exposes render /
  write / remove / list as separate pure functions instead of one
  `registerHub()`; the supervisor invocation lives in the CLI. Splitting the file
  work from the `launchctl`/`systemctl` calls is what makes the unit content
  testable without registering anything on the test machine.
- **`extraPorts` added to discovery.** Found while verifying live: the app's
  sidecar supervisor never passes `fixedPort` in production, so the app's hub
  takes an OS-assigned port OUTSIDE the block and the sweep could not see it —
  which would have broken the "list the app's hub too" decision. The CLI now
  feeds the app's port (read from `settings.server_port`, the channel it already
  used) into the sweep. Pinning the app's sidecar to `SIDECAR_FIXED_PORT` would
  be the tidier fix but changes app boot; noted as a follow-up.
- **`hub registered` command added** (not in the plan). Without it, a hub whose
  unit installed but whose process failed to boot is invisible: absent from `ls`,
  yet a unit file exists. It lists units and marks which are not running.
- **`SUPERVISED_HUB_NAME = 'app'`.** The supervised sidecar's ROOT basename is a
  platform state-dir name, meaningless as a hub label, so supervised hubs report
  a fixed `app` instead of a ROOT-derived name.
- **Publish workflow filename NOT renamed.** Only `scripts/publish-hub-runner.sh`
  → `publish-npm.sh`. npm Trusted Publishing pins the publisher to the exact
  workflow FILENAME, so renaming `.github/workflows/publish-hub-runner.yml` would
  revoke publish auth for all three packages until reconfigured on npm.
- **`private: true` kept** in the CLI's in-repo manifest, matching hub/runner —
  the publish script rewrites it to `private: false` at pack time, so the repo
  copy staying private prevents an accidental publish from another pnpm flow.

### Test-harness gotchas worth knowing

- The e2e suite runs under Electron (the hub bundle needs better-sqlite3's
  Electron ABI) but must launch the CLI with **plain node**: `process.execPath` is
  the Electron binary, and the scrubbed child env drops `ELECTRON_RUN_AS_NODE`, so
  running the CLI through it starts a GUI app that never exits and hangs the suite.
- Spawn the **real** Electron executable (from `electron/path.txt`), not
  `node_modules/.bin/electron` — the latter is a Node shim that spawns the binary
  as a child, so the pid the test holds is the shim's while `/health` reports the
  hub's, and a pid assertion can never match.
- The supervised-refusal stub must live in its **own process**: `slay()` uses
  `spawnSync`, which blocks the test's event loop, so an in-process stub could
  never answer the CLI's probe — it would read as "no hub there" and pass a
  refusal test that never exercised the refusal.
- Test hubs bind **inside** the hub block (no explicit port) because name lookup
  requires the sweep; safety against touching a developer's real hub comes from
  pid-unique hub NAMES that every assertion filters on, not from an out-of-block
  port.

### `slay hub start` — verified on macOS/launchd

Confirmed by hand (the one path automated tests must not take, since it installs a
real LaunchAgent):

- `hub start` in an empty dir → registered the plist, hub answered on 51110,
  `launchctl list` status **0**, exactly one boot sequence, empty error log.
- **Crash-restart works**: `kill -9` the hub → launchd relaunched it on the same
  port within ~3s under a new pid, with `-9` recorded as the previous exit.
- **A clean stop stays stopped**: `hub stop` → process gone, port closed, plist
  removed, job deregistered, and no resurrection after 6s (this is what
  `KeepAlive.SuccessfulExit=false` buys; a bare `KeepAlive: true` would have
  fought the stop).

Two bugs were found and fixed during that verification — see below. Linux/systemd
remains unverified by hand; its unit content is covered by the Phase 5 tests.

### Bugs found by running `hub start` for real

**1. Wrong interpreter → invisible crash-loop.** The unit ran the dev-tree hub
under plain `node`, but a checkout's `better-sqlite3` is compiled for ELECTRON's
ABI (`NODE_MODULE_VERSION 145` vs node's 137), so it died instantly on
`require('better-sqlite3')` — and launchd's `KeepAlive` retried it forever while
the command printed nothing. `interpreterFor()` now walks up from the bundle for an
`electron/path.txt`: found ⇒ run as `ELECTRON_RUN_AS_NODE=1 <electron>` (how the
desktop app spawns its own sidecar); absent ⇒ a published package, whose natives
were rebuilt for the local node, so plain node is right. `HubServiceSpec.env`
carries it into the unit. The unsupervised/Windows branch had the same gap.

**2. Silent failure that left a crash-looping unit registered.** `hub start`
printed nothing for 20s and then a bare "did not answer" pointing at a log file.
It now announces registration + start BEFORE waiting, and on failure
**unregisters** (otherwise the supervisor keeps retrying a hub the operator was
told is broken) and prints the last 12 lines of the child's own output inline.

**3. Needless double-start.** `supervisorStart` ran `bootstrap` (which already
starts the job via `RunAtLoad`) and then `kickstart -k`, which SIGTERMed that fresh
process and booted a second one — visible as a `-15` last-exit-status on an
otherwise healthy job. `bootstrap` alone is the whole start. `restart` is
unaffected: it is `bootout` → wait-gone → `bootstrap`, a genuine restart.

## Follow-ups

- Pass `SIDECAR_FIXED_PORT` as the app supervisor's `fixedPort` so the app's hub
  binds inside the block and needs no `extraPorts` special case. `fixedPort` is
  currently wired but only ever set by tests.
- `slay hub start --system` (root-owned daemon) for genuine pre-login boot.
- Windows service backend; today `detectBackend()` returns `none` there and
  `start` falls back to an unsupervised detached spawn.

## Open questions

None.
