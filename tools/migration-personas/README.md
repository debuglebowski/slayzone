# Migration personas

Tests every upgrade migration against **real user histories**. A persona is a user who
used SlayZone up to some old release and now jumps straight to today's code.

Local only (Docker, no network). Never part of CI.

## Concepts

- **Input** (`personas/<p>/input.tar.gz`): the persona's whole home directory, as that
  release's **real build** left it. Frozen forever, never regenerated or edited.
- **Expected** (`personas/<p>/expected/`): a normalized dump of the same home after
  today's code has booted on it. A new migration changes it, and that diff is what
  you review.
- **Invariants** (`expected/invariants.txt`): properties that must hold for every
  persona whatever the expected output says. A failing invariant fails the run even
  with `--update`.

| Persona | Release | Who |
| --- | --- | --- |
| `p01-v035-solo` | v0.35.0 (schema v145) | desktop only, one project, tasks/tags/template/artifact/automation/panel |
| `p02-v0362-multi` | v0.36.2 (schema v171) | 2 hubs, 4 computers, project + task bindings on both hubs |

## Running

```sh
tools/migration-personas/run.sh                    # every persona; compare with expected
tools/migration-personas/run.sh p02-v0362-multi    # one persona
tools/migration-personas/run.sh --update           # accept this run as the new expected
tools/migration-personas/run.sh --twice            # fail if two runs differ
```

Exit codes: 1 = the output differs from expected, 2 = an invariant failed, 3 = the run
itself broke (logs in `personas/<p>/actual/logs`).

`run.sh` builds `harness/Dockerfile` from the **working tree** (tracked plus untracked
files that aren't ignored), installed for Linux and plain Node. Then, per persona:

1. **Unpack.** The input is unpacked into a fresh container, with no network.
2. **Desktop boot, minus Electron.** The harness (`harness/main.ts`) replays the
   desktop app's boot in the same order as `packages/apps/app/src/main/index.ts`, using
   the app's own functions:
   - XDG move
   - `initStorageDir`
   - diagnostics DB
   - client-settings move
   - v127 disk move
3. **Hubs and computers.** It starts today's hub(s) and computer(s) with the same env
   the app and standalone users give them, then installs the agent hooks.
4. **Wait.** It waits until every computer in the topology has connected and the
   databases go quiet.
5. **Stop.** It stops everything gracefully, computers first.
6. **Dump and check.** It dumps every database and data file in normalized form and
   checks the invariants.

Normalization replaces values this run creates with stable tokens: `<new-uuid>` for
UUIDs not present in the input, `<run-ms>` / `<run-s>` / `<run-time>` for wall-clock
times. Logs and the user's own git repos are not dumped.

## Adding a persona

1. Write `generate/journeys/<release>-<name>/journey.sh`. It runs inside the old
   release's container and uses that release's own `slay` CLI and APIs. Helpers are in
   `generate/lib.sh`.
2. Add `personas/<p>/persona.json` with the release, the journey and the `topology`
   (which hubs and computers today's harness must boot).
3. Run `generate/generate.sh <p>` to write `input.tar.gz`.
4. Run `run.sh --update <p>`, then review `expected/`.

Generation runs the release's amd64 `.deb` (checksum-verified) under Xvfb, with **no
network**, because the old build's auto-updater would otherwise install the latest
release. The data stays inside the container until it is packed. Bind-mounting it from
macOS breaks SQLite WAL locking and silently loses writes.

## Not covered yet

- **Lazy migrations** that only run on use: per-task session recovery (v201) and the
  usage-cursor handoff (v209).
- **Login-required hubs.** Out of scope by decision.
- **macOS / Windows paths.** Linux only by decision. Path *values* from other platforms
  belong in persona data instead.
