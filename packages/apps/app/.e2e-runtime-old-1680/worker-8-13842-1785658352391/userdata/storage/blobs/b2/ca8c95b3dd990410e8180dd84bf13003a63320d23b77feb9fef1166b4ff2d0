# slay init — Instruction Text Alternatives

Three rewrites of the `INSTRUCTIONS` block appended to `CLAUDE.md` / `AGENTS.md` by `slay init`.

Source: `packages/apps/cli/src/commands/init.ts:10-20`.

---

## Current

```md
# SlayZone Environment

You are running inside [SlayZone](https://slayzone.com), a desktop development environment built around a kanban board. Each task on the board is a full workspace with terminal panels, a file editor, a browser panel, and git integration. Your session is one of potentially many agents working in parallel on different tasks. A human or another agent may interact with you through the terminal.

`$SLAYZONE_TASK_ID` is set to the ID of the task you are running inside. Most `slay` commands default to it when no explicit ID is given.

## slay CLI

You can interact with SlayZone via the `slay` CLI. **Load the `slay` skill before running any `slay` command** — it holds the full reference of commands, flags, and domain-specific guides. Do not guess subcommands or flags.
```

---

## Alt A — Terse, agent-first

Cuts marketing prose. Leads with "you are an agent" framing. Shortest of the three.

```md
# SlayZone Environment

You are an agent running inside a [SlayZone](https://slayzone.com) task — a workspace with terminals, an editor, a browser panel, and a git worktree. Other agents may be working on other tasks in parallel, and a human can reach you through this terminal at any time.

Your task ID is in `$SLAYZONE_TASK_ID`. Most `slay` commands default to it.

## slay CLI

Interact with SlayZone through the `slay` CLI. **Load the `slay` skill before running any `slay` command.** It has the full command reference — do not guess subcommands or flags.
```

---

## Alt B — Concrete mental model

Frames the task as a "workspace" up front, then names the panels. Keeps the multi-agent note but scoped tighter.

```md
# SlayZone Environment

[SlayZone](https://slayzone.com) is a desktop dev environment where each kanban task is its own workspace: terminal panels, a file editor, a browser panel, and a git worktree. You are the agent inside one such workspace. Other agents may be running in their own tasks in parallel; a human can message you through this terminal.

The surrounding task's ID is exported as `$SLAYZONE_TASK_ID` — most `slay` commands pick it up automatically.

## slay CLI

Use the `slay` CLI to interact with SlayZone. **Before running any `slay` command, load the `slay` skill** — it is the authoritative reference for commands, flags, and domain guides. Do not guess.
```

---

## Alt C — Structured, scannable

Bullets over prose. Good for agents that skim. Loses some flavor, gains clarity.

```md
# SlayZone Environment

You are running inside [SlayZone](https://slayzone.com), a desktop dev environment. Key facts:

- Each kanban task is a full workspace: terminal panels, file editor, browser panel, git worktree.
- You are one of potentially many agents, each scoped to its own task.
- A human or another agent can reach you through this terminal at any time.
- `$SLAYZONE_TASK_ID` holds the current task's ID. Most `slay` commands default to it.

## slay CLI

The `slay` CLI is how you interact with SlayZone.

**Load the `slay` skill before running any `slay` command.** It holds the full reference of commands, flags, and domain-specific guides. Never guess subcommands or flags.
```

---

## Notes on differences

| | Current | Alt A | Alt B | Alt C |
|---|---|---|---|---|
| Length | ~105 words | ~80 | ~105 | ~95 |
| Tone | descriptive | direct/agent-first | concrete/modeled | scannable |
| "You are an agent" framing | implicit | explicit | explicit | explicit |
| Format | prose | prose | prose | bullets |
| Keeps multi-agent note | yes | yes | yes | yes |
| Keeps `slay` skill rule | yes | yes | yes | yes |
