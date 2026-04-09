---
name: sync-slay-skill
description: "Read CLI command source files and regenerate the slay SKILL.md + init.ts command reference to match"
trigger: none
---

Synchronize the slay CLI reference documentation with the actual CLI source code.

## Targets

The CLI reference lives in one place:

1. **`.claude/skills/slay/SKILL.md`** — dev-facing, includes `--dev` reminder and environment variables table

## Step 1: Read CLI source files

Read these files in full to extract the command tree:

- `packages/apps/cli/src/index.ts` — root program, global flags
- `packages/apps/cli/src/commands/tasks.ts` — tasks, subtasks, tag; nests browser + assets
- `packages/apps/cli/src/commands/browser.ts` — browser subcommands (nested under `tasks`)
- `packages/apps/cli/src/commands/projects.ts`
- `packages/apps/cli/src/commands/tags.ts`
- `packages/apps/cli/src/commands/templates.ts`
- `packages/apps/cli/src/commands/automations.ts`
- `packages/apps/cli/src/commands/processes.ts`
- `packages/apps/cli/src/commands/pty.ts`
- `packages/apps/cli/src/commands/panels.ts`

Skip `completions.ts` and `init.ts` — internal/meta commands, not documented.

Also read both targets to understand current state:
- `.claude/skills/slay/SKILL.md`
- `packages/apps/cli/src/commands/init.ts`

## Step 2: Extract command tree

Parse Commander.js patterns to build the full command tree:

| Pattern | Meaning |
|---------|---------|
| `.command('name <req> [opt]')` | Command with positional args |
| `.description('text')` | Command description |
| `.option('--flag', 'desc')` | Optional boolean flag |
| `.option('--name <value>', 'desc')` | Optional value option |
| `.option('-s, --long <value>', 'desc')` | Short + long option |
| `.requiredOption('--name <value>', 'desc')` | Required option |

Nesting to track:
- `browserCommand()` is added to `tasks` via `cmd.addCommand(browserCommand())`
- `assetsSubcommand()` is added to `tasks` via `cmd.addCommand(assetsSubcommand())`
- Parent-level options (like `--panel <state>` on `browser`) are inherited by all subcommands — include them on each subcommand line

## Step 3: Regenerate the Commands section

Group commands into these categories (preserve this ordering):

| Section | Commands from |
|---------|---------------|
| Task lifecycle | `tasks view`, `tasks update`, `tasks done`, `tasks create` |
| Subtasks | `tasks subtasks`, `tasks subtask-add` |
| Task management | `tasks list`, `tasks search`, `tasks open`, `tasks archive`, `tasks delete` |
| Tags | `tasks tag` (all variants), `tags list`, `tags create`, `tags delete` |
| Templates | all `templates` subcommands |
| Browser panel | all `tasks browser` subcommands |
| Assets | all `tasks assets` subcommands |
| Projects | all `projects` subcommands |
| Automations | all `automations` subcommands |
| Processes | all `processes` subcommands |
| PTY sessions | all `pty` subcommands |
| Web panels | all `panels` subcommands |

Format each line as:
```
- `slay <command-path> <positional-args> <required-opts> [optional-opts]` — <description>
```

Rules:
- Required options (`.requiredOption`): bare syntax `--project <name>`
- Optional options (`.option`): bracket syntax `[--json]`, `[--limit <n>]`
- Short flags: use the short form only when conventionally expected (`-o`, `-n`, `-s`)
- `tasks tag`: document as multiple lines — one per usage pattern (show, `--set`, `--add`, `--remove`, `--clear`)
- Preserve command ordering within each group (most common first)
- Do NOT include option defaults in the signature

## Step 4: Update SKILL.md

In `.claude/skills/slay/SKILL.md`, replace ONLY the content between `## Commands` and `## Notes`.

**Preserve verbatim:**
- YAML frontmatter
- Intro paragraph (with `--dev` reminder)
- HTML comment about canonical source
- `## Global flags` section
- `## Environment variables` table
- `## Notes` section (unless a note references a removed command — update it)

## Step 5: Report changes

After updating, summarize:
- **Added**: commands in source but not previously documented
- **Removed**: commands previously documented but no longer in source
- **Changed**: options added/removed/renamed vs previous docs
- **Preserved**: confirm non-Commands sections unchanged

Tell user to review with `git diff`.

## Edge cases

- **New command file** imported in `index.ts` but not in the file list above → read it, ask user which category heading to use
- **Missing `.description()`** → use command name as placeholder, flag for review
- **Ignore** option default values (third arg to `.option()`)
