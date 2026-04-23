---
name: slay-automations
description: "Create and manage automations via the slay CLI"
trigger: auto
---

Automations are project-scoped, event-driven actions. They fire shell commands in response to task events or on a cron schedule.

## Trigger types

| Type | Fires when | Extra flags |
|------|-----------|-------------|
| `task_status_change` | Task status changes | `--trigger-from-status`, `--trigger-to-status` (both optional, filter transitions) |
| `task_created` | New task created | — |
| `task_archived` | Task archived | — |
| `task_tag_changed` | Tags modified on a task | — |
| `cron` | On schedule | `--cron <expression>` (required) |
| `manual` | Only via `slay automations run` | — |

## Commands

- `slay automations list --project <name|id> [--json]` — list automations for a project.
  - Shows enabled state, trigger type, run count, and last run time

- `slay automations view <id> [--json]` — view full automation details including trigger config, conditions, and actions.

- `slay automations create <name> --project <name|id> --trigger <type> [--action-command <cmd>] [--trigger-from-status <status>] [--trigger-to-status <status>] [--cron <expression>] [--description <text>] [--config <file>]` — create an automation.
  - For simple automations, use `--action-command` to specify a shell command
  - For complex setups with multiple actions or conditions, use `--config <file>` with JSON `{ trigger_config, conditions?, actions }` — overrides all other flags

- `slay automations update <id> [--name <n>] [--description <text>] [--enabled] [--disabled] [--trigger <type>] [--action-command <cmd>] [--trigger-from-status <s>] [--trigger-to-status <s>] [--cron <expr>]` — update an automation.
  - At least one option required

- `slay automations delete <id>` — permanently delete an automation.

- `slay automations toggle <id>` — flip the enabled/disabled state.
  - You don't need to know the current state — it toggles automatically

- `slay automations run <id>` — manually trigger an automation.
  - Requires the SlayZone app to be running (uses the app's HTTP API)
  - Reports status and duration

- `slay automations runs <id> [--limit <n>] [--json]` — view execution history.
  - Shows status, duration, and any errors
  - Default limit: 10

## Config file example

```json
{
  "trigger_config": { "type": "task_status_change", "params": { "toStatus": "done" } },
  "actions": [
    { "type": "run_command", "params": { "command": "echo 'Task completed!'" } }
  ]
}
```
