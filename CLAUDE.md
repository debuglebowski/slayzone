# SlayZone

You and I are developing SlayZone, a desktop task management app with integrated AI coding assistants (Claude Code, Codex, Gemini, and more).

You (this instance) is actually running inside SlayZone now. We are dogfooding SlayZone, i.e. using SlayZone to develop SlayZone.

You are able to interact with the running SlayZone application via the CLI. But **you MUST load the `slay` skill before running any `slay` CLI command.** Do not guess subcommands or flags — the skill has the full reference.

If you ever interact with the CLI, you must append the `--dev` flag, since we are running in dev mode.

The session is ran with the `$SLAYZONE_TASK_ID` environment variable, so you can omit the task-id unless you want to target another task.

## Communication Style

Default to **caveman ultra** mode for entire session. Load the `caveman` skill at session start. Skill's own boundaries (code/commits/PRs stay normal) still apply.

## Stack

- **Runtime**: Electron 41
- **Frontend**: React 19, TailwindCSS 4, Radix UI
- **Database**: SQLite (better-sqlite3)
- **Backend**: Convex (cloud), Express (local API)
- **Terminal**: node-pty, xterm.js
- **AI**: Claude Code, Codex, Gemini, Cursor, OpenCode, Copilot, Qwen + custom modes
- **Protocols**: MCP (Model Context Protocol)

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for system architecture and [PHILOSOPHY.md](./PHILOSOPHY.md) for structural principles.

## Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Start dev server |
| `pnpm build` | Build for production |
| `pnpm build:mac` | Build macOS .app |
| `pnpm typecheck` | Typecheck all packages |
| `pnpm test:e2e` | Run E2E tests (requires build) |
| `pnpm lint` | Lint all packages |

## Commit Messages

[Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Use for |
|--------|---------|
| `feat:` | New features |
| `fix:` | Bug fixes |
| `chore:` | Deps, CI, build, config |
| `refactor:` | Code restructuring (no behavior change) |
| `docs:` | Documentation |
| `test:` | Tests |
| `release:` | Version bumps (auto-generated) |

Scope optional: `feat(terminal): ...`

## E2E Testing Rules

- **TDD**: Always run tests FIRST to see them fail, then fix code. Never write tests alongside code and assume they pass.
- **useRef + useEffect for DOM measurement**: If a component has early returns (loading/null guards) before the measured element, `useEffect([], [])` runs when the ref is still null. Use a **callback ref** instead.
- **Hook lifecycle across tabs**: Hooks' `useEffect` only runs on mount. Tabs stay mounted with `display: none` — seeding settings and navigating doesn't re-trigger effects. Test by opening a NEW task (fresh hook mount).
