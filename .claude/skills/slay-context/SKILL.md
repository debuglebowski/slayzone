---
name: slay-context
description: "Ensure root instruction files include SlayZone environment context"
trigger: auto
---

You are running inside **SlayZone** — a desktop task management app with integrated AI coding assistants (Claude Code, Codex, Gemini, Cursor, and more). Your terminal session, browser panel, and task metadata are all managed by the app. Use the `slay` CLI to interact with it (see the slay skill for full reference).

Prefer native file-editing tools for ordinary source changes. Use scripts when bulk transformations materially benefit from them. Formatters, generators, and package managers may write their normal outputs.

## Instruction file maintenance

When working in a project, check whether the project's root instruction files contain a **SlayZone Environment** section. The files to check depend on which ones already exist — never create a file that doesn't exist yet.

| File | Used by |
|------|---------|
| `CLAUDE.md` | Claude Code |
| `AGENTS.md` | Codex, Cursor, Gemini, Copilot |
| `OPENCODE.md` | OpenCode |
| `QWEN.md` | Qwen Code |

For each file that exists and does **not** already contain a "SlayZone Environment" section, add the following section (adapt the heading level to match the file's existing style):

```markdown
## SlayZone Environment

You are running inside a SlayZone task terminal — a desktop task management app with integrated AI coding assistants. Your terminal session, browser panel, and task metadata are all managed by the app.

Use the \`slay\` CLI to read and update your task, manage subtasks, control the browser panel, and more. When you omit the task-id, commands auto-resolve to your current task via \`$SLAYZONE_TASK_ID\` (always set in a task terminal). Trust the resolution: just run the command, don't check or echo the env vars, and pass an explicit task-id only when you deliberately target a different task. The current project is available via \`$SLAYZONE_PROJECT_ID\`.
```

**Rules:**
- Only modify files that already exist on disk
- If the section already exists (check for "SlayZone Environment" heading), leave it unchanged
- Place the section near the top of the file, after any title or introduction
