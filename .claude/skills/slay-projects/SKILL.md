---
name: slay-projects
description: "Manage projects via the slay CLI"
trigger: auto
---

Projects group tasks, tags, templates, and automations. Each project can optionally be linked to a directory on disk.

Project names are resolved via case-insensitive substring matching — `slay tasks list --project my` matches "My Project". If multiple projects match, the CLI errors with all matching names to prevent ambiguity.

## Commands

- `slay projects list [--json]` — list all projects with task counts and paths.

- `slay projects create <name> [--path <path>] [--color <hex>] [--json]` — create a project.
  - `--path` is optional — projects can exist without a directory
  - Relative paths are resolved from the current working directory; directory is created recursively if it doesn't exist
  - Color defaults to #3b82f6

- `slay projects update <name|id> [--name <n>] [--color <hex>] [--path <path>] [--json]` — update a project.
  - At least one option required
  - Setting `--path` also auto-creates the directory
