# Slice 6 Readiness Audit — `@slayzone/server`

**Date:** 2026-06-10 · **Scope:** verify slices 3/4/5 are actually complete enough to start slice 6 (standalone `@slayzone/server`).
**Method:** 5 parallel read-only repo probes + direct source reads + ran the static guard + isolated typecheck of `@slayzone/server`. (grep counts via `rtk proxy` — plain grep is RTK-corrupted.)

---

## Verdict: ✅ ON TRACK. Ready to start slice 6.

Slice 6 is **not greenfield** — the slice-2.5 side-car already pre-built ~70% of it. Foundation (3/4/5) is solid. Remaining work is **additive** (migrations, MCP, REST, thin-wrapper cut-over), not corrective. Two "blockers" raised during audit were investigated and **debunked**.

---

## What already exists & is verified

| Capability | State | Evidence |
|---|---|---|
| `@slayzone/server` package | exists, **typecheck exit 0** | `packages/apps/server/`, deps = only `@slayzone/platform` + `@slayzone/transport` |
| `startServer(cfg)` API | matches slice-6 spec exactly | returns `{port,host,dataRoot,dbPath,healthCheck,stop}` — `src/index.ts`, `src/server.ts:11` |
| WS tRPC + `/health` | working, idempotent `stop()` | `server.ts:29-34` (`/trpc`), `health.ts` |
| appRouter source-of-truth | assembled in transport, imported clean | `server.ts:4` `import { appRouter } from '@slayzone/transport/server'` |
| Env-driven paths | no electron in boot path | `SLAYZONE_STORE_DIR / _DB_PATH / _HOST / _PORT`, `ensureDataRoot/getServerHost/getTrpcPort` |
| Electron-free boundary | **guard passes** across domains+transport+server | `scripts/check-server-electron-free.sh` → "Server boundary guards passed." |
| DB open (standalone) | direct better-sqlite3 via `SyncSlayzoneDb` | `db.ts:101`, env-resolved path `db.ts:26` |
| Supervisor / parent-death | done (slice 2.5.1) | `SLAYZONE_SUPERVISED`, crash-recovery test gate |

---

## Real gaps slice 6 must close (additive)

1. **Migrations not owned by server.** Supervised mode opens a host-pre-migrated DB verbatim (`db.ts:15-35`); standalone `openServerDatabase()` just opens — **no migration runner invoked**. Slice 6 "done when" requires the server to own bootstrap+migrations. → Boot against a fresh dir would open an unmigrated DB.
2. **MCP server not started.** `index.ts:10` "Reserved for slice 3+". Slice 6 wants MCP lifecycle owned by server.
3. **REST API absent.** Only `/health` + `/trpc`. Artifacts/blobs REST (`apps/app/src/main/rest-api/`, already electron-free) must boot inside the server.
4. **`namedTxn` unsupported standalone** (`db.ts:76` throws). Asserted safe because served routers don't use it — **verify this invariant holds** as routers grow, or port the named-txn registry server-side.
5. **App not yet a thin wrapper.** `apps/app/src/main/index.ts` (~3500 lines) still boots everything inline; 5–6 hardcoded `app.getPath()` calls remain in the boot path (`getTrpcDataRoot`/`getDatabasePath`, v127 disk migration). Slice 6 guts this to delegate to `startServer()`.
6. **Guard not in CI.** Wired into `pnpm lint:server-boundary` but `ci.yml` only runs `lint:theme` → boundary unenforced, drift risk. Add to CI as part of slice 6.

---

## Debunked during audit (NOT blockers)

- **"Routers must move into each domain (`@slayzone/tags/server` exports its router)."** No. Built cleaner: domains = pure ops, **transport = routers + appRouter**, server imports transport's appRouter. Electron-free, typechecks, works. The slice-6 plan *text* is superseded — **update the plan, don't move 33 routers.**
- **"4 domains (onboarding, task-browser, tasks, telemetry) lack `./server` → block slice 6."** No. Server never imports domains directly; it imports transport's appRouter. Server typecheck passes *through* transport → the whole router graph resolves. Those 4 are pure-client / electron-free-`main` already.

---

## Recommended slice-6 scope (revised, in order)

1. Add migration runner to `openServerDatabase()` (standalone path only; supervised stays verbatim).
2. Boot REST API inside `startServer()` (artifacts/blobs).
3. Add MCP lifecycle to `startServer()`.
4. Gut `apps/app/src/main/index.ts` → thin wrapper calling `startServer()` in `app.whenReady()`; keep electron-only (browser panel, menus, tray, dialogs).
5. Kill residual `app.getPath()` in boot path → env/config.
6. Add `lint:server-boundary` to `ci.yml`.
7. Smoke: `SLAYZONE_STORE_DIR=/tmp/x SLAYZONE_PORT=4000 node packages/apps/server/dist/bin.js` → `/health` 200.

## Decisions to ratify (unresolved Qs)
- Q1: Ratify routers-stay-in-transport (vs plan text)? (rec: yes)
- Q2: REST muxed on tRPC port, or own port?
- Q3: Migration ownership — server runs runner always, or only when not supervised?
