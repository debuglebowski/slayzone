# Automations — Feature Spec

## Triggers

| Trigger                      | Dialog UI | Params                                                         | Description                                     |
| ---------------------------- | --------- | -------------------------------------------------------------- | ----------------------------------------------- |
| `task_status_change`         | Yes       | `fromStatus?` (status dropdown), `toStatus?` (status dropdown) | Fires when a task changes status                |
| `task_created`               | Yes       | —                                                              | Fires when a new task is created                |
| `task_archived`              | Yes       | —                                                              | Fires when a task is archived                   |
| `task_tag_changed`           | Yes       | —                                                              | Fires when tags are added/removed from a task   |
| `cron`                       | Yes       | `expression` (cron input)                                      | Fires on a recurring schedule                   |
| `manual`                     | Yes       | —                                                              | Fires only when the user clicks the play button |

## Conditions (Only-if)

| Preset key      | Label                 | Value UI                                            |
| --------------- | --------------------- |  --------------------------------------------------- |
| `status_is_some`     | Task status is any of...     | Status multi-select                                     |
| `priority_is_some`   | Task priority is any of...   | Priority multi-select |
| `tags_contains_some`   | Task tags contains any of...   | Tags multi-select |

## Actions (Then)

Always only run_command. No dropdown needed here - only the command. Support template variables

## Template Variables

Available in `run_command` actions:

| Variable                        | Description                                  |
| ----------------------------    | -------------------------------------------- |
| `{{task.id}}`                   | Task ID                                      |
| `{{task.name}}`                 | Task title                                   |
| `{{task.status}}`               | Current task status                          |
| `{{task.priority}}`             | Task priority (number)                       |
| `{{task.worktree_path}}`        | Worktree path (if any)                       |
| `{{task.branch}}`               | Branch name (if any)                         |
| `{{task.agent_id}}`             | Task agent                                   |
| `{{task.agent_flags}}`          | Task agent current flags                     |
| `{{project.id}}`                | Project ID                                   |
| `{{project.name}}`              | Project name                                 |
| `{{project.path}}`              | Project directory path                       |
