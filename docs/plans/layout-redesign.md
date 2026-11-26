# Layout redesign

The design is the prototype artifact `slayzone-layout.html` in the task "🧭 Design alternative SlayZone layouts". This plan turns it into code in phases. Each phase ships on its own and keeps existing behavior unless the design replaces it.

## Phase 1: Sidebar chrome (tree view)

Status: done.

- Tree is the default view.
- Header: traffic lights, the centered "Slay Zone" wordmark, a mini usage meter (Claude/Codex bars, opens `UsagePopover`), and ☰ to hide the sidebar.
- Footer: one evenly spaced toolbar, with labels when the sidebar is at least 420px wide:
  - **New** opens a menu: New project…, New folder.
  - **Search** opens search (⌘K).
  - **Lens** shows the active lens and opens the lens menu.
  - **Setup** is the Getting started checklist with a count. It is hidden at 5/5 and moves into More.
  - **Shared** only appears when something is shared (phase 5).
  - **More** opens a menu:
    - Show all projects, Collapse all, and Layout › Tree / Tabs.
    - Settings, Keyboard Shortcuts, and Getting started (only once complete).
    - What's New, Usage Analytics, Leaderboard.
    - Send feedback.
    - Groups are separated by dividers, not labels.
- The old tree header buttons and `CompactFooter` go. Their actions move into the toolbar or More, so nothing is dropped:
  - The explode / global agent / agent status / active terminals entries move into More.
  - The auto-hide toggle moves into More.
  - Restart to update stays.
- Tabs view (rail): the footer shows today's icons (active terminals, getting started, leaderboard, usage, what's new, shortcuts, feedback, settings), and Layout (Tree/Tabs) replaces the view switcher. The tab bar keeps today's left and right actions.

## Phase 2: Lenses

Status: done.

- A lens is a saved sidebar preset: grouping (project / agent status / task status / recent), row look (cards / flat / accordion / dense), which projects, the "Needs you" strip, and the tree display settings.
- The built-in lenses are Today, Agent status, Task status, Recent and Accordion.
- Lens menu: lens rows with ✎ on hover, ⌃1–9 shortcuts, and Manage lenses….
- Edit modal tabs: Structure / What to show / How rows look.
- Settings page: the lens list, the editor, and a preview with Mock/Real data.
- Today's global `tree*` display settings become the first lens, so nothing is lost on upgrade.
- Built: the model is `packages/domains/tabs-state/src/lenses.ts`. Lenses and the active id live in the `viewState` slice next to the live `tree*` fields. The sidebar reads only the live fields: applying a lens writes them, saving copies them back, and "dirty" means they differ. The cross-project lists and the looks are in `packages/domains/sidebar/src/views/tree-view/lens-lists.tsx` and `TreeView.tsx`. The menu, editor and settings page are in `packages/domains/sidebar/src/lenses/`. The lens editor replaced the display-settings popover, and every setting moved into it.
- ⌃1–9 switches lenses on macOS. Windows and Linux use Alt+1–9, because Ctrl+1–9 already switches tabs there.

## Phase 3: Computer chip

Status: done.

- A "This Mac ▾" chip in the task title row, shown only when the project has a folder on more than one computer.
- It picks the computer where new agents and terminals start. Running sessions stay where they are.
- ⌘⇧M flips between the computers.
- The menu links to "Folders on each computer…", which opens the project settings.

## Phase 4: Panel model (task view)

Status: done.

- Columns of tab groups:
  - Drag-and-drop a tab: dropping on the middle of a group merges into it, dropping on an edge splits.
  - Groups resize in both directions.
- Everything is a tab: every panel type can have several instances, and each closes with ×, ⌘W or the right-click menu.
- One Agent panel type, with the provider picked on the panel.
- Settings splits into Description, Subtasks and Details panels.
- New panel types: Web page (a static URL) and Artifact (a single artifact).
- Title row: group toggles, a ⋯ menu for new panels, and the layout button (icon only).
- Saved layouts: built-in "Classic" (today's defaults), plus user layouts with Manage layouts (bulk actions, enable switches) and ⌥1–9 shortcuts.
- Migration: per-task `panel_visibility` and `panel_sizes`, and the global `panel_config`, map onto the Classic layout.
- Built from its own design doc, docs/plans/panel-model.md (steps 1–14).

## Phase 5: Sharing

Status: waiting on task 812f5341.

- Task 812f5341 makes invites member-only and removes "Shared with me".
- An artifact shared on its own appears behind the **Shared** footer button: a popover grouped by project, view only, with a new-item dot.
