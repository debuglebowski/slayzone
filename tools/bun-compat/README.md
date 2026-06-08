# Bun compatibility probe

Phase 3.5 of the Chromium migration. Exercises every native/heavy-CJS
dependency the sidecar imports, catches the ones Bun can't handle, and
emits a report the runtime selector (`@slayzone/sidecar/runtime`) reads
to decide whether to launch under Bun or Node.

## Running

```
bun run tools/bun-compat/check.ts      # primary target
pnpm exec tsx tools/bun-compat/check.ts  # Node baseline
```

Writes a machine-readable summary to `tools/bun-compat/report.json`.

## Current verdict (Bun 1.3.6 on darwin-arm64)

| module         | status   | notes                                                              |
|----------------|----------|--------------------------------------------------------------------|
| better-sqlite3 | blocked  | Bun 1.3.6 does not support it. See oven-sh/bun#4290. Suggested      |
|                |          | upstream alternative: `bun:sqlite`. For now, sidecar defaults to   |
|                |          | Node via `@slayzone/sidecar/runtime` — `decideSidecarRuntime()`    |
|                |          | returns `{ runtime: 'node', reason: 'better-sqlite3-blocked' }`.   |
| node-pty       | ok       | Spawns a PTY, writes, reads back within 1.5 s.                     |
| convex         | ok       | `convex/browser` constructor shape OK; no wire connection made.    |
| express        | ok       | Bound a listener, performed a fetch round-trip.                    |
| ws             | ok       | Server + client round-trip.                                        |
| msgpackr       | skipped  | Not currently installed. Plan lists it as a forward-looking dep.   |

## Override

If you want to force a runtime:

```
SLAYZONE_RUNTIME=node   # recommended default
SLAYZONE_RUNTIME=bun    # only once better-sqlite3 unblocks
```

## Adding a new module to the probe

1. Add a `probe('name', async () => { /* import + exercise */ })` block in
   `check.ts`. Exercise step should hit a non-trivial code path (not just
   module load), since some Bun incompatibilities only surface at use.
2. Run `bun run tools/bun-compat/check.ts`; add the module to
   `BUN_BLOCKED_MODULES` in `packages/sidecar/src/runtime/select.ts` if it
   blocks.
3. Re-run on Node via `pnpm exec tsx tools/bun-compat/check.ts` to make
   sure the probe itself is sound.
