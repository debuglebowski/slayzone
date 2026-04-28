---
name: slay-browser
description: "Control the task browser panel via the slay CLI"
trigger: auto
---

Browser commands control the browser panel embedded in each task's detail view. All commands require `$SLAYZONE_TASK_ID` to be set (automatic in task terminals).

## Global flags

- `--panel <state>` — `visible` or `hidden`. `navigate` defaults to `visible` (auto-opens the panel); all other commands default to `hidden` (operate without showing the panel).
- `--tab <idOrIdx>` — target a specific tab. Accepts a 0-based index (e.g. `--tab 1`) or an opaque tab id (e.g. `--tab default`). Pure-digit values are treated as indices and resolved via `slay tasks browser tabs`. Without `--tab`, commands target the currently active tab.

## Commands

- `slay tasks browser tabs [--json]` — list browser tabs for the current task.
  - Output columns: `active | idx | id | title | url`. The active tab is marked with `*`.
  - Tabs that haven't been loaded yet are marked `(not loaded)` — they exist in the task's saved state but their `WebContentsView` hasn't mounted (typically because the panel is closed).

- `slay tasks browser navigate <url> [--panel <state>] [--tab <idOrIdx>]` — navigate the targeted tab to a URL.
  - The only command that auto-shows the browser panel.
  - With `--tab`, the panel auto-opens and switches to that tab before loading the URL.

- `slay tasks browser url [--panel <state>] [--tab <idOrIdx>]` — print the targeted tab's current URL.

- `slay tasks browser screenshot [-o <path>] [--panel <state>] [--tab <idOrIdx>]` — capture a screenshot of the targeted tab.
  - Returns the file path of the saved image.
  - `-o` copies the screenshot to a specific path; without it, prints the temp file path.

- `slay tasks browser content [--json] [--panel <state>] [--tab <idOrIdx>]` — get the targeted tab's text content and interactive elements as JSON.
  - Text content truncated to 10k characters.
  - Interactive elements include links, buttons, and inputs.

- `slay tasks browser click <selector> [--panel <state>] [--tab <idOrIdx>]` — click an element on the targeted tab by CSS selector.
  - Returns the tag name and text of the clicked element.

- `slay tasks browser type <selector> <text> [--panel <state>] [--tab <idOrIdx>]` — type text into an input on the targeted tab by CSS selector.

- `slay tasks browser eval <code> [--panel <state>] [--tab <idOrIdx>]` — execute JavaScript in the targeted tab's context and print the result.
  - Strings are printed as-is.
  - Other values are pretty-printed as JSON.

## Targeting notes

- Default target = the currently active tab. Existing scripts without `--tab` keep working.
- When a `--tab` value cannot be resolved, the server returns 404 with the available tabs listed for discovery. The CLI also prints the available tabs when an index lookup fails.
- A `--tab` reference by index can shift if the user reorders or closes tabs. For long-lived scripts that need a stable reference, use the opaque tab id (printed by `slay tasks browser tabs`).

## Workflow tips

A typical browser verification flow:
1. `navigate` to the URL
2. `content` to inspect the page and find selectors
3. `click` or `type` to interact
4. `screenshot` to capture the result

For multi-tab flows, run `slay tasks browser tabs` first, then pass `--tab N` (or the tab id) to subsequent commands.
