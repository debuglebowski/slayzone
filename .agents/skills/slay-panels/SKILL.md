---
name: slay-panels
description: "Manage web panels and a task's panel layout via the slay CLI"
trigger: auto
---

Web panels are custom browser views available in the task detail sidebar, alongside the built-in browser tab. Use them for dashboards, documentation, design tools, or any web app you want quick access to from every task.

SlayZone ships with predefined panels for Figma, Notion, GitHub, Excalidraw, and Monosketch. Deleting a predefined panel prevents it from being re-added automatically.

## Commands

- `slay panels list [--json]` — list all web panels with their ID, name, URL, keyboard shortcut, and enabled state.

- `slay panels create <name> <url> [-s <letter>] [--block-handoff] [--protocol <protocol>]` — create a custom web panel.
  - `-s` assigns a single-letter keyboard shortcut (some letters reserved: t, b, e, g, s)
  - `--block-handoff` prevents desktop app protocol URLs (e.g. `figma://`) from opening the native app — keeps navigation inside the panel
  - `--protocol` specifies which desktop protocol to block (inferred from URL hostname if omitted; requires `--block-handoff`)

- `slay panels delete <id-or-name>` — delete a web panel by ID or name (case-insensitive name match).

- `slay panels enable <id-or-name>` — show the panel in task view.
  - Panels are enabled by default when created

- `slay panels disable <id-or-name>` — hide the panel from task view without deleting it.
  - The panel config is preserved

## Task layout

A task's panels are tabs in groups, groups stacked in columns. `slay panels layout` shows and changes the layout of a task (default: the current task, `$SLAYZONE_TASK_ID`; `-t <id>` for another). Changes show up in the open task view at once; a change you make from a task terminal offers the user **Undo**. If the user turned off "Agent may change the layout" (Manage layouts), every change fails with `layout_locked` — don't retry, tell the user.

- `slay panels layout show [--json]` — columns, groups and panels with their **panel ids** (`terminal` = the main agent, `browser`, `editor`, `diff`, `settings`, `browser:1a2b3c4d` …), which are hidden or parked, and the layouts `apply` takes.

- `slay panels layout apply <layout>` — switch to a layout by id or name (`classic`, `focus`, `pair`, `review`, the user's own …). Panels with live state (agent sessions, open pages, open files) that the layout has no place for are parked, never lost.
  - `apply <file.json>` / `apply -` (stdin) applies a whole layout; edited `show --json` output works.

- `slay panels layout open <kind> [--settings <json>] [--placement <where>] [--name <name>]` — open a panel. Kinds: `agent`, `terminal`, `browser`, `web`, `editor`, `artifacts`, `artifact`, `git`, `processes`, `settings`, `description`, `subtasks`, `details`.
  - `--settings`: `{"url":"https://…"}` for a web page, `{"artifactId":"…"}` for an artifact, `{"provider":"codex"}` for an agent panel
  - `--placement`: `column[:<index>]` (default: a new column at the end), `tab:<group-or-panel>[:<index>]` (a tab next to a panel), `split:<group-or-panel>:<left|right|before|after>`
  - An agent or terminal panel starts its own terminal. A one-per-task kind (`settings`, `description`, `subtasks`, `details`) or an artifact already in a panel is shown instead of opened twice. On the Classic layout, a kind whose panel is hidden (or parked) is shown rather than opened again; once it is visible, `open` adds another.

- `slay panels layout hide <panel-id>` — hide a panel in place (its whole group when it is the group's last shown tab). Open it again with `open <kind>` or the task view's toggles.

- `slay panels layout close <panel-id>` — close a panel. The first panel of a kind (`terminal`, `browser`, `editor`, `diff`, …) is only hidden.
