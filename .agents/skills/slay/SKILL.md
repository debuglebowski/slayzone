---
name: slay
description: "Full CLI reference for slay — orchestrates all slay domain skills"
depends_on:
  - slay-context
  - slay-tasks
  - slay-browser
  - slay-assets
  - slay-automations
  - slay-projects
  - slay-processes
  - slay-pty
  - slay-panels
  - slay-auto-title
trigger: auto
---

Use the `slay` CLI to interact with the SlayZone task management system. The current task ID is available via `$SLAYZONE_TASK_ID` and the current project via `$SLAYZONE_PROJECT_ID` (both set automatically in task terminals).

All ID arguments support prefix matching (e.g., `a1b2` matches the full UUID starting with `a1b2`).

## Domains

| Skill | Commands | Purpose |
|-------|----------|---------|
| slay-context | — | Ensure root instruction files include SlayZone context |
| slay-tasks | `slay tasks`, `slay tags`, `slay templates` | Task lifecycle, subtasks, tags, templates |
| slay-browser | `slay tasks browser` | Control the task browser panel |
| slay-assets | `slay tasks assets` | Manage files and folders attached to tasks |
| slay-automations | `slay automations` | Event-driven and cron automations |
| slay-projects | `slay projects` | Project CRUD |
| slay-processes | `slay processes` | Inspect and control running processes |
| slay-pty | `slay pty` | Interact with PTY terminal sessions |
| slay-panels | `slay panels` | Manage custom web panels |
| slay-auto-title | — | Auto-title tasks from conversation context |

## Other

- `slay init instructions` — print SlayZone agent configuration template
- `slay init skills` — install all built-in slay skills from the marketplace registry
- `slay completions <shell>` — generate shell completions (fish | zsh | bash)
