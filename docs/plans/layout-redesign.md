# Layout redesign

The design is the prototype artifact `slayzone-layout.html` in the task "🧭 Design alternative SlayZone layouts". This plan turns it into code in phases. Each phase ships on its own and keeps existing behavior unless the design replaces it.

## Phase 1: Sidebar chrome (tree view)

- Tree is the default view.
- Header: traffic lights, the centered "Slay Zone" wordmark, a mini usage meter (Claude/Codex bars, opens `UsagePopover`), and ☰ to hide the sidebar.
- Footer: one evenly spaced toolbar, with labels when the sidebar is at least 420px wide:
  - **New** opens a menu: New project…, New folder.
  - **Search** opens search (⌘K).
  - **Lens** opens the lens menu. Until phase 2 it opens the display settings.
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

- A lens is a saved sidebar preset: grouping (project / agent status / task status / recent), row look (cards / flat / accordion / dense), which projects, the "Needs you" strip, and the tree display settings.
- The built-in lenses are Today, Agent status, Task status, Recent and Accordion.
- Lens menu: lens rows with ✎ on hover, ⌃1–9 shortcuts, and Manage lenses….
- Edit modal tabs: Structure / What to show / How rows look.
- Settings page: the lens list, the editor, and a preview with Mock/Real data.
- Today's global `tree*` display settings become the first lens, so nothing is lost on upgrade.

## Phase 3: Computer chip

- A "This Mac ▾" chip in the task title row, shown only when the project has a folder on more than one computer.
- It picks the computer where new agents and terminals start. Running sessions stay where they are.
- ⌘⇧M flips between the computers.
- The menu links to "Folders on each computer…", which opens the project settings.

## Phase 4: Panel model (task view)

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
- This phase needs its own design doc before code: `TaskDetailPage.tsx` is 4k lines with hand-written panel blocks.

## Phase 5: Sharing

- Task 812f5341 makes invites member-only and removes "Shared with me".
- An artifact shared on its own appears behind the **Shared** footer button: a popover grouped by project, view only, with a new-item dot.
