---
name: slay-panels
description: "Manage web panels via the slay CLI"
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
