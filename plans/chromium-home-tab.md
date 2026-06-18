# Chromium Fork — Home Tab (incremental slice 1)

## Goal
Render the Home experience in the Chromium fork renderer-app: **ticket renderer + filtering + display only**. No panels, no tab system. Data via the standalone sidecar over tRPC-WS. Incremental — proves the seam, more slices follow.

## Locked decisions
1. **Transport**: sidecar tRPC-over-WS. Reuse `@slayzone/transport/client` (`initTrpcClient`, `TrpcProvider`, `useTRPC`). No net-new client.
2. **Scope**: single Home view mounted as root. No `useTabStore`, no tab shell, no 6 panels. **Keep** Kanban drag/reorder (electron-free, free).
3. **Sidecar must run**: drop `SLAYZONE_NO_SIDECAR=1` from the chromium run path.
4. **ThemeProvider** wired immediately (don't hardcode tokens).
5. **No new package**. Reuse `@slayzone/tasks` (KanbanBoard/KanbanListView/FilterBar/useTasksData/useFilterStore). Defer `@slayzone/home` extraction until panels land in chromium.
6. **Server URL**: optional chrome flag `--slayzone-server-url`; else build-time default. Requires **pinned port** (gives up dynamic-port collision-avoidance for v1 — accepted).
   - dev default: `ws://127.0.0.1:8766/trpc`
   - prod default: `ws://127.0.0.1:8765/trpc`
   - selected via `__DEV__` build define in chromium-shell.
7. **windowId**: hardcode `1` (single-window fork).

## Confirmed facts
- `@slayzone/tasks` ticket/filter UI = electron-clean. Only `useTasksData` hard-imports `electronBootstrap` (4 boot-mark sites).
- Sidecar serves tRPC-WS on TCP loopback `/trpc` (`packages/apps/server/src/server.ts`). chrome:// can open `ws://127.0.0.1:PORT/trpc` (no CORS block on loopback).
- Chromium fork has **zero** tRPC today (Mojo/window.api only).
- shim `app.getServerUrl()` + `app.getWindowId()` = stubbed (return `[]`).
- **`run.sh:52` is BROKEN** — spawns non-existent `packages/sidecar/src/bin/main.ts`. Real entry = `packages/apps/server/src/bin.ts` (`dist/bin.cjs`).
- No fixed port today: sidecar binds `0` (dynamic), writes actual to DB `mcp_server_port`. Pinning to 8766/8765 is the v1 choice.

## Work items (ordered)
- **A — runner**: `scripts/chromium/run.sh`
  - fix sidecar bin path → `packages/apps/server/src/bin.ts` (or built `dist/bin.cjs`).
  - drop `SLAYZONE_NO_SIDECAR=1`; ensure sidecar actually spawns + binds TCP.
  - `export SLAYZONE_PORT=8766` (dev) so bind matches default.
  - pass optional `--slayzone-server-url=...` through to chrome binary (override channel).
- **B — shim**: `packages/shared/window-api-shim/src/shims/app.ts`
  - implement `getServerUrl()`: read `--slayzone-server-url` flag → else `__DEV__ ? :8766 : :8765`, return `{mode:'local', url}`.
  - implement `getWindowId()` → `1`.
- **C — decouple**: `packages/domains/tasks/src/client/useTasksData.ts`
  - make `electronBootstrap` no-op-safe outside electron (sustainable shared util, not scattered `typeof` guards). Net-good for canonical app too.
- **D — renderer bootstrap**: chromium renderer-app entry
  - `initTrpcClient(getServerUrl)` before mount; wrap tree in `TrpcProvider` + `ThemeProvider`.
- **E — HomeView**: new thin component in renderer-app
  - compose `FilterBar` + `KanbanBoard`/`KanbanListView` (from `@slayzone/tasks`), fed by `useTasksData` + `useFilterStore`. Mount as root (alongside/replacing the stub TaskDetailsView entry per hash/mode).
- **F — verify**: runner boots sidecar; chrome:// opens WS; tickets render, filter works, DnD reorder persists via tRPC.

## Risks / watch
- ThemeProvider: fork layout pkg currently hardcodes colors → bring real theme tokens (`@slayzone/ui` ThemeProvider).
- `useTasksData` uses tRPC **subscriptions** (`useSubscription`) — WS link must carry them (it does in canonical; confirm under chrome://).
- `--slayzone-server-url` flag must reach renderer — same C++→renderer channel as existing `--slayzone-*-bundle-dir` flags (confirm wiring).
- Pinned port collision (rare on loopback). Accepted for v1.

## Status — IMPLEMENTED (2026-06-17)
Files:
- `package.json`: `build:chromium` builds server too; `run:chromium` drops `SLAYZONE_NO_SIDECAR=1`.
- `scripts/chromium/run.sh`: spawn sidecar via electron-as-node `server/dist/bin.cjs` (ABI), `SLAYZONE_PORT=8766`, `/health` poll, `env -u SLAYZONE_SUPERVISED` + `</dev/null` hardening.
- `window-api-shim/src/server-url.ts` (new) + `shims/app.ts`: `getServerUrl` (default :8766 dev / :8765 prod, `window.__slayzoneServerUrl` override) + `getWindowId`→1 + `bootMark` no-op.
- `transport/src/client/electron-bootstrap.ts`: `bootMark`/`dataReady` optional-chained (decouple done HERE, not in useTasksData — single chokepoint, covers its calls).
- `chromium-shell/vite.config.ts`: `__SLAYZONE_CHROMIUM_PROD__` define.
- `chromium-shell/src/main.css` (new): Tailwind v4 theme-token scaffold (mirrors canonical; focused @source). `main.tsx`: import css + dynamic `mountApp` import.
- `renderer-app/src/HomeView.tsx` (new): composes FilterBar + KanbanBoard/KanbanListView from `@slayzone/tasks`. `main.tsx`: async bootstrap → TrpcProvider + ThemeProvider + HomeView (overlay/`#task-demo` still routed). `package.json`: +tasks/settings/transport deps. `tsconfig.json`: +txn-registry.d.ts include.

Verified:
- Sidecar boots electron-as-node on :8766, `/health` → `{"ok":true,...}` HTTP 200, 145 migrations (ABI ok), survives backgrounding, clean SIGTERM.
- `pnpm --filter @slayzone/chromium-shell build` green (3742 modules; 121KB CSS = theme utilities generated).
- typecheck clean: window-api-shim, transport, renderer-app.

NOT verified (needs the built fork binary — `scripts/chromium/build.sh`, ~70GB): actual chrome:// paint. Run `pnpm dev:chromium` in a real window.

Deferred (not blocking):
- `--slayzone-server-url` chrome-flag override needs C++ to inject `window.__slayzoneServerUrl`; today only the build-time default resolves. Dev default (:8766) works out-of-box via run.sh port pin.
- Don't run the chromium sidecar alongside the Electron dev app on the same dev DB.
