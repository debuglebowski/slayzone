# Fork: search / command palette (extract SearchDialog)

Goal: real Cmd+K command palette in the chromium fork. Extract canonical `SearchDialog` into a package, register in the fork's store-driven `AppDialogs`, wire Cmd+K. Don't break Electron.

## Current state (verified)

- `SearchDialog` + 7 siblings live UNPACKAGED in the Electron renderer:
  `packages/apps/app/src/renderer/src/components/dialogs/`
  - `SearchDialog.tsx`, `SearchDialog.types.ts`, `SearchDialog.algorithm.ts`,
    `SearchDialog.constants.ts`, `SearchDialog.utils.ts`, `SearchResults.tsx`,
    `ActionShortcut.tsx`, `Highlight.tsx`
  - external consumers: ONLY `app-shell/lazy.ts` + `app-shell/useIdlePreload.ts`
    (both `import('@/components/dialogs/SearchDialog')`). `ActionShortcut`/`Highlight`
    used only by `SearchResults`. Clean to move all 8.
- Component deps (all barrel): `@slayzone/ui`, `@slayzone/icons` (FileIcon),
  `@slayzone/settings` (`useDialogStore`, `Tab`, `SearchFileContext`),
  `@slayzone/task/shared` (`Task`, `priorityOptions`), `@slayzone/projects/shared` (`Project`),
  `@slayzone/telemetry/client`, `@slayzone/transport/client`, `fzf`, `lucide-react`.
- Fork `AppDialogs` (`packages/apps/renderer-app/src/AppDialogs.tsx`) = store-driven,
  currently EMPTY (only Toaster). Has `useLazyMounted()` gate ready. Mounted at HomeView root.
- `useDialogStore` already has `searchOpen` / `openSearch({fileContext?})` / `closeSearch`.
- Build config auto-discovers: `slayzoneDeps` derives from app `package.json`;
  `discoverDomainClientEntries()` globs `packages/domains/*/src/index.ts`.
  → NO `electron.vite.config.ts` edit needed; only add dep to app package.json.

## Plan

### 1. New package `@slayzone/search` (sidebar precedent)
- `packages/domains/search/` → `package.json` (name `@slayzone/search`, `main`/`types`/`exports .` + `./client` → `./src/index.ts`, no build), `tsconfig.json` (mirror sidebar: extends base, include `txn-registry.d.ts`).
- Move the 8 files into `src/`. Internal relative imports unchanged.
- `src/index.ts` barrel: `export { SearchDialog }` + `export type { SearchDialogProps, ... }`.
- deps: `@slayzone/ui`, `@slayzone/icons`, `@slayzone/settings`, `@slayzone/task`,
  `@slayzone/projects`, `@slayzone/telemetry`, `@slayzone/transport`, `fzf`, `lucide-react`; peer `react`.

### 2. Electron app rewire (keep working)
- `app-shell/lazy.ts`: `import('@slayzone/search')`.
- `app-shell/useIdlePreload.ts`: `import('@slayzone/search')`.
- app `package.json`: add `@slayzone/search: workspace:*`.
- Delete the 8 moved files from the app dialogs dir.
- `pnpm install` (workspace symlink).

### 3. Tailwind @source (BOTH)
- `packages/apps/chromium-shell/src/main.css`: `@source "../../../domains/search/src";`
- `packages/apps/app/src/renderer/src/assets/main.css`: `@source "../../../../../../../packages/domains/search/src";`

### 4. Register in fork `AppDialogs` (lazy + Suspense, store-driven)
- Lazy import `SearchDialog` from `@slayzone/search`.
- `shouldMount('search', searchOpen)` + `<Suspense fallback={null}>`.
- Props sourced store-driven:
  - `open`=`useDialogStore(s=>s.searchOpen)`; `onOpenChange`→`closeSearch()`
  - `tasks`/`projects` ← `useTabStore(s=>s._taskLookup)` (HomeView keeps it fresh; cast to `Task[]`/`Project[]`)
  - `closedTabs` ← `useTabStore(s=>s.closedTabs)`
  - `openTaskTabs` ← `useTabStore(s=>s.tabs)` filtered `type==='task'`
  - `activeTaskId` ← active tab if task else null
  - `onSelectTask` → `taskDetailCache.prefetch` + `useTabStore.getState().openTask(id)`
  - `onSelectProject` → `selectProject(id)`
  - `onNewTask` → `openCreateTask()` (no-ops gracefully until ported)
  - `onReopenClosedTab` → `reopenClosedTab()`
  - `onAddProject` → `openCreateProject()` (graceful no-op)
  - `onGoHome` → `setActiveTabIndex(homeIdx)`
  - `onOpenChangelog` → `openChangelog()` (graceful no-op)
  - `onOpenSettings` → `openSettings()` (graceful no-op)
  - `onNewTemporaryTask` → `trpcClient.task.create.mutate({projectId, title:'Terminal N', isTemporary:true})`
    (status OMITTED — server defaults it), update `_taskLookup`, `openTask(id)`
  - `onToggleGlobalAgentPanel` → **only HomeView-owned bit** (see Q2)

### 5. Cmd+K hotkey (fork)
- In HomeView: mirror canonical resolution — `useShortcutStore` overrides + `shortcutDefinitions`
  → `getKeys('search')` (default `mod+k`), `useShortcutStore.getState().load()` on mount,
  `useGuardedHotkeys(getKeys('search'), () => openSearch({...}), { enableOnFormTags: true })`.
  All from `@slayzone/ui` (already a dep).
- Open WITHOUT `fileContext` for now (file-search needs a home editor-ref not wired in fork;
  tasks/projects/actions search works). Deferred follow-up.

### 6. Verify — DONE ✅
- Typecheck (isolated, all EXIT 0): @slayzone/search, agent-panels, home, renderer-app, chromium-shell, app renderer (web).
- REAL fork window (prebuilt binary + live 8766 sidecar, CDP-driven):
  - Cmd+K opens palette (Actions + Recent Tasks groups, ⌘ shortcut hints). ✅
  - Fuzzy search: "slay" → 50 File results (file-search wiring works); "investigate" → Tasks group w/ status+priority badges. ✅
  - Selecting "Investigate Chromium" opened+focused the task tab (palette auto-closed). ✅
  - Esc closes. ✅
  - Theming/CSP correct; shared viewState restored after (closed the verification tab).
- Electron unbroken: app renderer typechecks clean; SearchDialog now imported from @slayzone/search via lazy.ts/useIdlePreload.ts.

### Notes / learnings
- Build config auto-discovers new domain pkgs: `slayzoneDeps` derives from app package.json; `discoverDomainClientEntries()` globs `packages/domains/*/src/index.ts` → NO electron.vite.config.ts edit.
- `task.create` status is OPTIONAL (sidecar resolves project default) → scratch terminal needs no client-side columns.
- Parallel agents extended fork AppDialogs to take `data`/`selectedProjectId`/`onSelectProject`/`onOpenTask` props → search block reuses them (typed tasks/projects, onOpenTask reuse).
- CDP gotcha verifying the fork: `Input.dispatchKeyEvent` (synthetic) does NOT trigger react-hotkeys-hook; dispatch a real `KeyboardEvent` on `document` via `Runtime.evaluate` instead.

## Resolved decisions (user)

1. **New `@slayzone/search`** package (sidebar precedent).
2. **Make agent-panel state a shared store.** Convert `useGlobalAgentPanelState` (agent-panels pkg) from per-instance React state → singleton zustand store, mirroring `useTabStore` (zustand + `getTrpcClient` hydrate/persist, self-hydrate on first mount, `isLoaded` gate). KEEP `[state, update]` API exactly → Electron App.tsx + fork HomeView unchanged. Then AppDialogs toggles it store-driven (no props). (`useAgentStatusState` left as-is.)
3. **Wire file-search now.** `HomeContainer` is fork-only (Electron uses `HomeDetail` directly) → add `editorHandleRef` prop exposing `openFile` (canonical homePanel logic) via `useImperativeHandle`. Fork HomeView holds the ref, builds `buildHomeFileContext()` (projectPath + openFile→activate home tab + editor), passes via `openSearch({fileContext})`. SearchDialog reads `searchFileContext` from store (unchanged).
