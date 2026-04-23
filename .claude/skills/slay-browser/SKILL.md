---
name: slay-browser
description: "Control the task browser panel via the slay CLI"
trigger: auto
---

Browser commands control the browser panel embedded in each task's detail view. All commands require `$SLAYZONE_TASK_ID` to be set (automatic in task terminals).

Every command accepts `--panel <state>` (visible | hidden). `navigate` defaults to `visible` (auto-opens the panel), all other commands default to `hidden` (operate without showing the panel).

## Commands

- `slay tasks browser navigate <url> [--panel <state>]` — navigate to a URL.
  - The only command that auto-shows the browser panel
  - Use to open pages for verification, testing, or reference

- `slay tasks browser url [--panel <state>]` — print the current URL.
  - Useful for checking where the browser is after navigation or redirects

- `slay tasks browser screenshot [-o <path>] [--panel <state>]` — capture a screenshot.
  - Returns the file path of the saved image
  - `-o` copies the screenshot to a specific path; without it, prints the temp file path

- `slay tasks browser content [--json] [--panel <state>]` — get the page's text content and interactive elements as JSON.
  - Text content truncated to 10k characters
  - Interactive elements include links, buttons, and inputs
  - Useful for understanding page structure before clicking or typing

- `slay tasks browser click <selector> [--panel <state>]` — click an element by CSS selector.
  - Returns the tag name and text of the clicked element

- `slay tasks browser type <selector> <text> [--panel <state>]` — type text into an input element by CSS selector.

- `slay tasks browser eval <code> [--panel <state>]` — execute JavaScript in the browser context and print the result.
  - Strings are printed as-is
  - Other values are pretty-printed as JSON

## Workflow tips

A typical browser verification flow:
1. `navigate` to the URL
2. `content` to inspect the page and find selectors
3. `click` or `type` to interact
4. `screenshot` to capture the result
