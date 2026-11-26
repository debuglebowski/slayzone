# Panel model: columns of tab groups

This is phase 4 of [layout-redesign.md](./layout-redesign.md). It replaces the task view's panel system with the decided model in steps that each ship on their own. The design reference is the prototype `slayzone-layout.html` in the task "🧭 Design alternative SlayZone layouts".

## 0. Principles

- **Nothing changes until a step means it to.** Steps 1–4 are refactors and data work only. Today's e2e suite passes without modification: `19-panel-toggles`, `25-panel-resize`, `124-136` tab-switch, and the browser specs.
- **The first instance of each kind keeps its old id.** These are `terminal`, `browser`, `editor`, `artifacts`, `diff`, `settings`, `processes` and `web:*`. Ownership, `panel_sizes`, `data-panel-id`, `focusedPanel`, shortcuts, palette commands, `taskPaneEvents` and e2e selectors all keep working. New instances get the id `<kind>:<uuid8>`.
- **The hub keeps the legacy columns in sync (dual-write).** This follows the precedent of `provider_config` → `*_flags` in `task/src/server/ops/shared.ts`. Older apps, the CLI and REST keep using `panel_visibility` and `panel_sizes`.
- **We don't reuse the store or tree from `@slayzone/layout`.** It is a recursive split tree with one global store, and several task pages are mounted at once. We borrow only its ideas: DnD zone parsing, hiding native views during a drag, and pure tree operations.

## 1. Data model

### 1.1 Types

New file: `task-contracts/src/layout/types.ts`.

- `PanelInstance {id, kind, name?, settings}`
  - `kind` is one of: `agent`, `terminal`, `browser`, `web`, `editor`, `artifacts`, `artifact`, `git`, `processes`, `settings`, `description`, `subtasks`, `details`.
  - `settings` is validated per kind with zod, and unknown keys are preserved.
- `LayoutTab {instanceId, hidden?}`
- `LayoutSlot {id, name?, hidden?, weight, activeInstanceId, tabs}`
- `LayoutColumn {id, size: PanelLayout, sizeOverride?, slots}`
- `TaskLayout {v: 1, rev, layoutId, columns, instances}`
- `LayoutDefinition {id, name, builtin, enabled, shortcutIndex?, columns, instances}`
- `TaskLayoutsSetting {v: 1, defaultLayoutId, builtinOverrides, user, order}`

How the model behaves:

- **Hiding keeps position.** A hidden slot or tab stays in the tree. A column whose slots are all hidden is not passed to `resolveLayout`.
- **Column sizing reuses `usePanelSizes`.** `size` and `sizeOverride` mirror `effectiveLayout()`. Showing a group clears its override, the same way `resetPanelSize` works today.
- **Operations are pure.** They live in `layout/ops.ts`: `moveTab`, `splitAt(zone)`, `mergeInto`, `reorderTab`, `setSlotHidden`, `setTabHidden`, `closeInstance`, `renameSlot`, `resizeColumns`, `resizeSlots`, `addInstance`, `prune` and `normalize`. Each one returns a new object and bumps `rev`.

### 1.2 Persistence

| Data | Where |
|---|---|
| Applied layout | New column `tasks.panel_layout` (JSON). `NULL` means it is derived from the legacy columns. |
| Heavy state of non-primary instances | New column `tasks.panel_instance_state` (JSON) |
| Layout of a template | New column `task_templates.panel_layout` |
| Layout definitions | New per-user setting `task_layouts` |
| "Agent may change the layout" | New per-user setting `agent_may_change_layout` (default `'1'`) |
| Web panels, enabled kinds, default sizes | `panel_config`, unchanged |

The migration only adds the columns, with no backfill. A backfill would be wrong because `panel_config.order` is per user on a multi-user hub. Deriving the layout on read is correct by construction.

### 1.3 Mapping from the legacy model

- `panel_visibility.{id}` ↔ `hidden` on the slot that holds primary instance `{id}`.
- `panel_sizes.{id}` ↔ `sizeOverride` of a column whose only visible instance is primary `{id}`.
- **Classic layout.** It is computed from `panel_config.order`, `.layout` and `.viewEnabled.task` until the user edits Classic.
- **Terminals.** `terminal_tabs` stays the source of truth for sessions. Agent and terminal instances point to groups through `terminalGroupIds`. The primary instance shows every group that no other instance has claimed.
- **Browser.** `browser_tabs` stays one flat list per task, plus an optional `byPanel` map.
- **Web panels.** `web_panel_urls` is keyed by instance id.
- **Editor, git, artifacts and diff state** belong to the primary instance. Other instances keep theirs in `panel_instance_state`.

### 1.4 Compatibility

New file: `layout/legacy.ts`. It has three functions:

- `deriveLayoutFromLegacy` builds a layout from the old columns.
- `projectToLegacy` turns a layout back into the old columns. The hub calls it on every `panelLayout` write.
- `applyLegacyWrite` handles older clients that write only the legacy fields.

| Client | Hub | Behavior |
|---|---|---|
| New app | Old hub | The app derives the layout and writes only the legacy fields. Multi-instance and layout UI is disabled, with an "Update the hub" message. |
| Old app | New hub | `applyLegacyWrite` keeps the layout in sync. Extra instances are invisible to the old app. |
| CLI, REST, MCP | Any | `/api/panels*` is unchanged. Browser commands target the primary browser. |

## 2. Rendering architecture

- **`TaskPageContext`** holds what the panel blocks currently capture from the task page's scope.
- **Kind registry** (`panels/registry.ts`). It absorbs `task-detail/TaskPanels.ts`. Each kind defines:
  - label, icon, and shortcut id
  - `multiInstance`, `defaultSettings` and `parseSettings`
  - `keepAlive`: `activity`, `mounted` or `unmount-when-hidden`
  - whether it may open in a secondary window (agent and terminal never)
  - `Component`, an optional `TabAccessory` (the agent provider picker), and an optional `onCloseRequest`
- **Keep-alive matches today.**
  - Browser and web stay mounted and are parked off-screen.
  - Agent and terminal use `Activity hidden`. Their sessions survive unmount.
  - All other kinds use `Activity hidden` and unmount when their group is hidden.
- **`PanelFrame`** replaces the eight copied wrappers. It provides the border, focus glow, `data-panel-id`, owner stub, Suspense and Activity.
- **Layout renderer** (`layout/`).
  - `TaskLayoutView` keeps `#task-panels` and calls the existing `resolveLayout`/`planPanelStrip`. Classic column ids equal the old ids, so Classic renders pixel-identical.
  - `LayoutColumn` stacks slots vertically by weight, using `ResizeHandle` with `axis: 'y'`.
  - `TabGroup`/`TabStrip` hide the strip for an unnamed slot with one tab, so Classic looks like today.
  - `useTaskLayout` owns the state. It writes through a debounced `updateTask({panelLayout})` and merges incoming changes by `rev`.
- **Drag and drop** uses dnd-kit.
  - Drop zones appear only while dragging: left or right of 20%, top or bottom of 30%, and merge in the middle.
  - Nothing reflows before the drop.
  - Native views are hidden through the existing `isResizing` path.
  - A layout has at most 8 columns.

## 3. Steps

Each step passes typecheck, lint and e2e. New e2e specs are numbered from 235.

1. **`TaskPageContext` and `PanelFrame`.** Refactor only, no UX change.
2. **Panel blocks become kind components** behind the registry, in `panels/kinds/*`. Refactor only, no UX change. The task page shrinks by about 1,500 lines.
3. **Layout types, ops and legacy adapters** in contracts. Unit tests cover every op and the derive/project round-trip.
4. **Migration and hub dual-write.** Columns, row mapper, `updateTask`, templates and shims.
5. **Layout renderer behind Classic**, pixel-identical. `handlePanelToggle` keeps its signature. A parity e2e compares bounding boxes before and after.
6. **Vertical slots and resizing.** Adds "Split down/right" to the context menu.
7. **Multiple instances of every kind.** Uses ownership by instance, `panel_instance_state`, `browser_tabs.byPanel` and a terminal group filter. Handlers resolve the focused instance, falling back to the primary.
8. **Tab strip and drag and drop.** Adds ×, ⌘W and right-click (Rename / Hide / Close). Closing an agent with a live session asks for confirmation.
9. **Title row.** Group toggles, the ⋯ "New panel" menu and the Layout button. Both header modes stay, and `panel-*` shortcuts toggle the group that holds each kind.
10. **Layout definitions.** Switch, save, save as and revert. Switching never destroys live state: leftover instances are parked as hidden tabs (`LayoutTab.parked`, listed under ⋯ → Parked). New tasks start from the template's layout, else the user's default layout (sent by the creating client as `defaultPanelLayout`; Classic as shipped sends nothing and stays derived).
11. **Manage layouts dialog and layout editor.** The editor works by dragging panel types onto the layout.
12. **New kinds.** Web page, Artifact, and Description/Subtasks/Details split out of Settings. Adds an agent provider per panel.
13. **The agent can change the layout.** Adds `/api/tasks/:id/layout` and `/panels` REST routes, the `slay panels layout …` CLI and an undo toast. Gated by `agent_may_change_layout`.
14. **Cleanup and docs.** Dual-write stays until every app channel reads `panel_layout`.

## 4. Open questions

1. Should existing terminal sub-tabs become panel tabs, and when? The plan keeps them inside the primary agent panel for now.
2. Layouts are stored per task and shared by everyone on a hub. Members with view-only access should probably get a local-only layout.
3. ~~⌥1–9 for layouts clashes with ⌥-digit input in xterm on macOS and with the lens shortcuts.~~ Decided (step 10): ⌃⌥1–9 on every platform, nine customizable `switch-layout-N` shortcuts, the N-th enabled layout in menu order. They work from a focused terminal (capture phase).
4. Many mounted browser views use a lot of memory. Inactive ones could be capped or hibernated.
5. Old apps on a new hub can't see extra instances. Release notes must say so.
6. ~~Once Classic is overridden, reordering in Settings → Panels no longer affects it.~~ Done (step 11): Settings → Panels says "Classic is customized — edit it in Layouts" and links to Manage layouts; a customized Classic no longer follows `panel_config`.
