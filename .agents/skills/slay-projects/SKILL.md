---
name: slay-projects
description: "Manage projects via the slay CLI"
trigger: auto
---

Projects group tasks, tags, templates, and automations. Each project runs on one computer of its hub (where its agents run), and can optionally be linked to a directory on that computer.

Project names are resolved via case-insensitive substring matching — `slay tasks list --project my` matches "My Project". If multiple projects match, the CLI errors with all matching names to prevent ambiguity.

## Commands

- `slay projects list [--json]` — list all projects with task counts, computer and paths.

- `slay projects create <name> [--path <path>] [--computer <name|id>] [--color <hex>] [--json]` — create a project.
  - `--path` is optional — projects can exist without a directory
  - `--computer` picks the computer (name, id or id prefix; no match lists the hub's computers). Default: the hub picks
  - When the folder is on this machine (local hub, no `--computer`): relative paths are resolved from the current working directory; directory is created recursively if it doesn't exist
  - Otherwise `--path` must be absolute on that computer and is not created; the CLI warns if the computer doesn't have it
  - Color defaults to #3b82f6

- `slay projects update <name|id> [--name <n>] [--color <hex>] [--path <path>] [--computer <name|id>] [--json]` — update a project.
  - At least one option required
  - `--computer` moves the project to that computer; `--path` is then its folder there
  - Setting `--path` auto-creates the directory only when it is on this machine (same rule as create)
