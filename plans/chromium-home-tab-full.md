# Chromium Fork — Full Home experience (slice 2)

Make the Home tab fully functional: left sidebar (project + task tree), the 5
panels, panel layout (toggle/resize), and the tab-bar chrome — before the
TaskDetails (per-task) view.

## Portability findings (all verified clean unless noted)

**Sidebar** (`app` pkg `components/sidebar/`: AppSidebar, ProjectsRailView,
TreeView ~1600 LOC, tree-view/*): zero electron/window.api coupling; pure React
+ dnd-kit + `@slayzone/settings` zustand + types. ONE tRPC call
`app.window.setWindowButtonVisibility` (mac traffic-lights) → fork shim/no-op.
**Lives in the app package, not a shared one** → must extract or copy.

**5 panels** (all clients are tRPC-only, zero electron imports):
| Panel | Status | Blocker |
|---|---|---|
| Processes | ✅ port as-is | none (pure node sidecar: spawn/pty) |
| Tests | ✅ port as-is | none (DB + fs scan) |
| Automations | ✅ port as-is | none (DB + engine) |
| Editor (FileEditorView) | 🟡 | `showInFinder` server proc → `getAppDeps().shellShowItemInFolder` |
| Git (UnifiedGitPanel) | 🟡 | `revealInFinder` → same shell-reveal dep |

→ Editor+Git share ONE missing native capability: **shell reveal-in-finder**.
Everything else is pure node the sidecar already does. Options: implement one
Mojo host (`shell.showItemInFolder`) or stub/no-op for v1.

**Layout system**: `useHomePanel` + `useHomePanelState` (app-local hooks, zero
coupling, tRPC settings persistence) + `ResizeHandle`/`usePanelSizes` (already
shared in `@slayzone/task`). Portable.

**TabBar + useTabStore**: TabBar app-local, useTabStore shared
(`@slayzone/settings`); zero electron; tRPC `settings` + sessionStorage. Note
`useTabStore` calls `pty.warmSetProjectTabCounts` (warm-shell gate) — sidecar
pty or no-op. **Tension: a tab bar is only useful once task tabs open something
(TaskDetails, which is deferred)** — so tabs may belong WITH TaskDetails, not
before.

## Key architecture decision — how to share the Home shell

The `app`'s HomeDetail takes ~26 props, but they almost all come from hooks that
ALREADY live in shared packages (`useTasksData`, `useFilterState`,
`useUndoableTaskActions`, `useHomePanel`, `useDialogStore`). The "App.tsx
entanglement" is mostly just *wiring* those shared hooks — which can itself move
into a shared package.

- **(A) Extract `@slayzone/home`** — a `HomeContainer` that wires the shared
  hooks + renders the panels, consumed by BOTH the canonical app and the fork.
  Canonical App.tsx swaps its inline HomeDetail+wiring for `<HomeContainer>`.
  No drift. Touches the working app (migrate carefully, keep e2e green). **← recommended (sustainable, single source of truth).**
- (B) Reimplement a thin HomeDetail in the fork. Faster, doesn't touch canonical,
  but creates two Home shells that drift.

## Proposed phasing (incremental)
1. **Panel layout + 3 clean panels** — extract `useHomePanel`/`useHomePanelState`
   (into `@slayzone/home` if (A)); wire Processes/Tests/Automations + toggle/resize.
2. **Git + Editor panels** — + the shell-reveal capability (Mojo host or stub).
3. **Sidebar** — extract `components/sidebar/*` to a shared pkg (or copy); wire
   project/task tree, the `setWindowButtonVisibility` shim; SidebarProvider from `@slayzone/ui`.
4. **Tab bar** — only the home-tab chrome; task tabs gated on TaskDetails (see tension above).

## Progress (this session)
DONE + pushed (origin/main): `04d5619f` hooks→@slayzone/home · `76c0fc0f` HomeDetail+lazy→home · `992e13ff` HomeContainer · `12668e77` fork renders full 6-panel home · `49a1ff3e` sidecar native reveal/open · `f37d1833` canonical uses shared HomeDetail. **Home tab fully functional in the fork + shared no-drift.**

## Step 5 — sidebar extraction (audited, ready; NOT yet done)
Scope: 28 files, ~6760 LOC under `packages/apps/app/src/renderer/src/components/sidebar/` → new `@slayzone/sidebar` pkg. Zero electron coupling. Do as a **focused pass** — it touches the live app's whole left-nav; ~20 edits + live-app typecheck iterations (too risky to cram). Move attempted + cleanly reverted (tree green).

Deps for pkg: ai-config, platform, projects, settings, tags, task, tasks, terminal, transport, ui + @dnd-kit/{core,sortable,utilities} + @radix-ui/react-collapsible + lucide-react + react-icons.

5 app-local couplings → resolutions (preserve ALL canonical behavior via prop-threading through AppSidebar):
- `AppSidebar.tsx:16,37` `OnboardingChecklistState` (`@/hooks/useOnboardingChecklist`) → define structural type in pkg; stays a prop.
- `AppSidebar.tsx:222` `trpcClient.app.window.setWindowButtonVisibility` → `onSetWindowButtonVisibility?(visible)` callback prop (app injects tRPC call).
- `SidebarFooterIcons.tsx:3,62,120` `isConvexConfigured` (`@/lib/convexAuth`) → `convexConfigured?: boolean` prop; `:4,120` `FeedbackDialog` → `feedbackSlot?: ReactNode` prop.
- `ShortcutsDialog.tsx:14,128` `KeyRecorder` (`@/components/KeyRecorder`) → `keyRecorder` component prop.
- `TreeView.tsx:27,178` `useActiveSessionTaskIds` (`@/components/agent-status/useIdleTasks`) → `sessionTaskIds?: Set<string>` via `SidebarViewContext` (types.ts); `:32,1433` `logo` (`@/assets/logo.svg`) → move asset into pkg + add `vite-env.d.ts` (svg ambient).
- `App.tsx:52` import `@/components/sidebar/AppSidebar` → `@slayzone/sidebar`; `:1247` render passes the new props (wraps tRPC call, convex bool, `<FeedbackDialog/>`, `<KeyRecorder/>`, `useActiveSessionTaskIds()`).
- KeyRecorder/FeedbackDialog/useOnboardingChecklist/useActiveSessionTaskIds/logo STAY app-side (injected via props).
Then **Step 5b — fork layout**: sidebar-left + home-right; sidebar drives `selectedProjectId` (replaces the interim picker in renderer-app HomeView).

## Locked decisions
1. **(A) Extract `@slayzone/home`** — `HomeContainer` (wires shared hooks + renders panels) consumed by BOTH apps; canonical App.tsx migrates to it. Single source of truth, no drift. Migrate carefully, keep e2e green.
2. **Extract `components/sidebar/*` to a shared pkg** (both apps consume).
3. **reveal-in-finder = sidecar implementation (b)** — implement `shellShowItemInFolder` in the node server via per-OS exec (`open -R` / `explorer /select,` / `xdg-open`), as a fallback when no Electron host. Fixes Git+Editor reveal on the fork (and any standalone server) with no Mojo/C++ rebuild.
4. **Tabs deferred to the TaskDetails slice, BUT build the placeholder tab-bar chrome now** (home tab visible; task tabs land with TaskDetails).
5. Order: **layout + 3 clean panels → Git/Editor (+ sidecar reveal) → sidebar → tab-bar placeholder.**
6. `setWindowButtonVisibility` + `pty.warmSetProjectTabCounts` on the fork: shim/no-op for v1 (revisit when native window controls land).
