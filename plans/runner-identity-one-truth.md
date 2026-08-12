# One truth for "does this runner exist"

## The bug this fixes

```
$ slay runner create matrix --token …
A runner is already installed in ~/.slayzone/runner — "matrix".
$ slay runner start matrix
No runner named "matrix" on this machine. No runners are registered.
```

Both true. No CLI command reaches that state — `create` refuses (root occupied),
`start`/`stop`/`rm`/`restart`/`logs` all refuse (no unit). Recovery today is
`rm -rf` by hand.

## Root cause

The unit file does DOUBLE DUTY: supervision artifact AND the machine-wide index of
"what runners exist here". It is absent exactly when there is no supervisor, so the
index disappears while the runner keeps existing.

The hub has no such bug because it binds a port: `discoverHubs()` sweeps
`HUB_PORT_BLOCK` and finds hubs regardless of who started them. Discovery is
supervisor-independent. A runner binds nothing, so unit enumeration became the index
by default — `runner.ts:388` says so outright: *"with no port to sweep, enumeration
IS the listing"*. That comment is the defect, written down.

The trigger here: `slay runner create` ran while `detectBackend()` returned `none`
(unrelated `XDG_RUNTIME_DIR` gap). It wrote root state, spawned a process, wrote no
unit. Once the supervisor came back the two oracles disagreed permanently.

## Three facts, currently conflated

| Fact | Durable record | Checked by |
|---|---|---|
| **installed** — this root holds a runner | `<ROOT>/runner.config.json` `runnerName` | only `create` (`runner.ts:537`) |
| **supervised** — the OS will restart it | launchd/systemd unit | `start` `stop` `rm` `restart` `logs` via `requireRegistered` (`runner.ts:135`) |
| **enrolled** — a hub accepts it | hub DB `runners` table | only the app's Runners tab |

`create` asks #1, everything else asks #2, and the code treats them as one question.
`installed ∧ enrolled ∧ ¬supervised` is legal, reachable, and unaddressable.

## Decided

1. **The hub is the runner registry.** A runner exists to serve a hub; the hub's
   enrollment table is the durable, supervisor-independent record. `runners.list`
   already returns it with live connection status — it is what Settings → Runners
   renders. Reuse it; invent no new state.
2. **No machine-scoped registry file.** Already rejected for hubs
   (`hub-lifecycle-and-discovery.md` §"Why /health probe"): it violates
   standalone-state-in-CWD and still misses foreign starts. The same reasoning holds
   here, and the hub channel makes it unnecessary.
3. **`start` self-heals rather than refusing.** Installed-but-unsupervised is a
   repairable state, not an error: write the unit and start. This is what removes the
   dead end — `rm` accepting orphans (the tourniquet) becomes a consequence, not the
   fix.
4. **`create` becomes all-or-nothing.** Today it half-commits under `none`. Write
   both records or neither.
5. **Local-only runners stay first-class.** A runner whose hub is unreachable must
   still be listable and removable, so the resolver merges hub data with local disk
   state and never *requires* the hub to answer.

## Architecture

One resolver, consulted by every subcommand:

```ts
// packages/apps/cli/src/commands/runner-identity.ts (new)
export interface RunnerFacts {
  name: string
  root: string | null        // from unit, else the occupied-root scan
  installed: boolean         // <ROOT>/runner.config.json names this runner
  supervised: boolean        // unit file present
  enrolled: boolean          // hub knows it
  running: boolean           // supervisor state, else pid probe
  connected: boolean         // hub reports a live socket
}
export function resolveRunner(name: string, opts?: {root?: string}): Promise<RunnerFacts>
export function listRunners(): Promise<RunnerFacts[]>
```

`listRunners()` unions three sources, keyed by name:
- hub `runners.list` (best-effort; hub down ⇒ skip, never fail)
- unit files via `listRegisteredUnits('runner', backend)`
- the CWD root, when it holds a `runner.config.json`

Every row carries which sources saw it, so a split state is *visible* rather than
contradictory.

## Phases

### P1 — resolver + `ls`
New `runner-identity.ts`. `runner ls` renders `NAME · STATE · SUPERVISED · ENROLLED ·
ROOT · HUB`. Drops the `backend === 'none'` early return entirely: with the hub as a
source there is something to list on a supervisor-less box, which is the whole point.
`--json` returns `RunnerFacts[]`.

### P2 — `start` self-heals
`installed ∧ ¬supervised ∧ backend ≠ none` ⇒ write the unit from the root's recorded
config, then start. Report it (`"Registered matrix (was unsupervised) and started."`).
`backend === 'none'` ⇒ foreground-spawn as today, say it is unsupervised.

### P3 — `create` all-or-nothing + adopt
Wrap in a rollback: on any failure after the first write, unwind config + unit + spawn.
Occupied root whose `runnerName` matches the requested name and which has no unit ⇒
**adopt** (write the unit, start) rather than refuse. Different name in an occupied
root still refuses — that is a genuine conflict.

### P4 — `rm` / `stop` / `logs` accept partial existence
Replace `requireRegistered` with `resolveRunner`. `rm` removes every record that
exists (unit, config, credentials) and reports which. Refuse only when no source knows
the name.

### P5 — `detectBackend` diagnostics
Separate cause from consequence. Bus unreachable while `/run/user/$(id -u)` exists is
a fixable environment gap, not "this platform has no user service manager" — the
message that sent this whole investigation down the wrong path for an hour. Return a
reason alongside the backend and surface it:

```
user service manager unreachable — the bus exists but XDG_RUNTIME_DIR is unset.
  export XDG_RUNTIME_DIR=/run/user/$(id -u)
```

Optionally self-heal: set it in the child env when the directory exists. Decide during
implementation — the honest error may be better than magic.

## Tests

| What | Where |
|---|---|
| resolver unions hub + unit + root; hub down degrades, never throws | `runner-identity.test.ts` (new) |
| `installed ∧ ¬supervised` → `ls` shows one row, not two, not zero | `runner-identity.test.ts` |
| **the exact wedge: create-under-`none`, then `start` succeeds** | `runner-lifecycle.test.ts` |
| `create` rollback leaves NO config when unit write fails | `runner-lifecycle.test.ts` |
| `rm` removes a config-only orphan | `runner-lifecycle.test.ts` |
| adopt: same name + occupied root + no unit ⇒ registers | `runner-lifecycle.test.ts` |
| different name in occupied root still refuses | existing, must stay green |
| backend reason: bus-unreachable ≠ no-backend | `service-unit.test.ts` |

TDD (`feedback_tdd`): the wedge test first, red, before P1. It reproduces via
`SLZ_FORCE_NO_SERVICE=1` on create then unset for start — the suite already has that
lever.

## Out of scope

- `hub` command parity. Hubs degrade correctly (port sweep + SIGTERM fallback) so they
  do not wedge. Aligning them on one resolver is a follow-up, not a fix.
- Runner health beyond `connected`. The hub already answers that.
- Windows service backend.

## Resolved

1. **`ls` with the hub unreachable** — show the row with `ENROLLED=?` and a one-line
   footer naming the hub it could not reach. Hiding rows makes the list lie in exactly
   the situation the operator is debugging.
2. **P5 self-heals.** When `/run/user/$(id -u)` exists and `XDG_RUNTIME_DIR` is unset,
   set it in the child env for every `systemctl --user` call AND persist nothing. The
   bus address is derivable from the uid, so asking a human to export it is asking them
   to retype something we already know. Diagnose only when the directory is genuinely
   absent (then linger is the real fix). "Make it work" beats "explain why it doesn't".
3. **Adopt silently** on an exact name+root match with no unit. There is one runner
   there, it has the name you asked for, and you asked to create it — a `--adopt` flag
   would exist solely to make you type it a second time.

## Unresolved questions

None.

## Done

All five phases landed. 119 assertions green across the touched suites (runner-lifecycle
24, hub-lifecycle 34, service-unit 37, hub-discovery 16, health 8). `@slayzone/platform`,
`@slayzone/transport`, `@slayzone/hub` and `@slayzone/cli` typecheck clean.

### Deviations from the plan

- **`GET /api/computers` had to be written.** The plan said "reuse `runners.list`" — but
  that is tRPC, and the CLI has no tRPC client (the same wall `join-token` hit). Added
  the REST twin plus a `getGateway` accessor on `RestApiDeps.runners`, wired to the
  SAME late-bound ref the tRPC procedure reads, so the two can never report different
  connection status.
- **The hub probe cannot use `hubRequest`/`resolveHubRequestTarget`.** Both call
  `fail()` = `process.exit(1)`, which `try/catch` cannot intercept — so the first
  implementation made `slay runner ls` die whenever no hub was running, several were
  (ambiguous target), or the hub predated the endpoint. Caught by the suite. The probe
  is now a bare `fetch` that cannot exit, and skips the hub source entirely rather than
  asking "which hub did you mean" — a question `ls` has no business asking.
- **`create` adopts ONLY when a supervisor exists.** The plan said adopt on an exact
  name+root match with no unit. Under `backend === 'none'` there is nothing to adopt
  INTO, and no way to tell whether that runner is already running (it is a bare
  detached process) — adopting would spawn a rival sharing one credential store. The
  existing "refuses a second runner under a name it already spawned" test caught this.
  Unsupervised same-name now still refuses.
- **Roots resolve from `SLAYZONE_ROOT`, not `cwd`.** Matches how the runner binary
  anchors itself; `cwd` alone missed a runner whose root came from the environment.
- **`rm --purge` added** (not in the plan). Without it the only way to free a root was
  `rm -rf` by hand — the very thing this work set out to remove.
- **No `ls-units` diagnostic.** Briefly added, then deleted: a second way to ask the
  same question is the disease, not the cure.

### Not verified — needs the VPS

`start` self-healing an unsupervised runner into a real systemd unit. The suite forces
`SLZ_FORCE_NO_SERVICE=1` throughout and asserts no unit is ever installed, so the
register-and-start path is covered only by its components. On the box:

```
slay runner ls                 # the orphan should list as "unmanaged"
slay runner start matrix       # expect "installed but not registered — registering it"
slay runner ls                 # now "running"
```
