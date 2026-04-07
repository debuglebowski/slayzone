# SlayZone

Desktop task management app with integrated AI coding assistants (Claude Code, Codex, Gemini, and more).

## SlayZone Environment

You are running inside a SlayZone task terminal — the same application you are developing. Your terminal session, browser panel, and task metadata are all managed by the app. Use the `slay` CLI to read and update your task, manage subtasks, control the browser panel, and more — see the `slay` skill for the full command reference.

## Quick Start

```bash
pnpm install
```

**Never start the dev server** - user runs it separately.

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

## Monorepo Structure

```
packages/
├── apps/
│   ├── app/             # @slayzone/app - Electron shell
│   └── cli/             # @slayzone/cli - CLI tool
├── domains/
│   ├── ai-config/       # @slayzone/ai-config
│   ├── automations/     # @slayzone/automations
│   ├── diagnostics/     # @slayzone/diagnostics
│   ├── file-editor/     # @slayzone/file-editor
│   ├── history/         # @slayzone/history
│   ├── integrations/    # @slayzone/integrations
│   ├── onboarding/      # @slayzone/onboarding
│   ├── projects/        # @slayzone/projects
│   ├── settings/        # @slayzone/settings
│   ├── tags/            # @slayzone/tags
│   ├── task/            # @slayzone/task
│   ├── task-browser/    # @slayzone/task-browser
│   ├── task-terminals/  # @slayzone/task-terminals
│   ├── tasks/           # @slayzone/tasks
│   ├── telemetry/       # @slayzone/telemetry
│   ├── terminal/        # @slayzone/terminal
│   ├── test-panel/      # @slayzone/test-panel
│   ├── usage-analytics/ # @slayzone/usage-analytics
│   └── worktrees/       # @slayzone/worktrees
└── shared/
    ├── editor/          # @slayzone/editor - Milkdown
    ├── icons/           # @slayzone/icons
    ├── platform/        # @slayzone/platform
    ├── shortcuts/       # @slayzone/shortcuts
    ├── suspense/        # @slayzone/suspense
    ├── test-utils/      # @slayzone/test-utils
    ├── types/           # @slayzone/types - ElectronAPI
    ├── ui/              # @slayzone/ui - Components
    └── workflow/        # @slayzone/workflow
```

## Domain Structure

Each domain:
```
domain/
├── DOMAIN.md           # Documentation
└── src/
    ├── shared/         # Types, contracts → ./shared
    ├── main/           # IPC handlers → ./main
    └── client/         # React UI → ./client
```

## Domain Packages

| Package | /shared | /main | /client |
|---------|---------|-------|---------|
| @slayzone/ai-config | ProviderConfig, SkillFrontmatter | AI config handlers | ContextManager, Settings |
| @slayzone/automations | Automation types, templates | AutomationEngine, handlers | AutomationsPanel |
| @slayzone/diagnostics | Diagnostic types | diagnostics handlers, processService | — |
| @slayzone/file-editor | FileEditor types | file watcher handlers | FileEditorView |
| @slayzone/history | History types | history recorder, handlers | — |
| @slayzone/integrations | Integration types | adapter registry, sync utils | — |
| @slayzone/onboarding | — | — | OnboardingDialog |
| @slayzone/projects | Project | Project CRUD | ProjectSelect, dialogs |
| @slayzone/settings | Theme | Settings, theme | ThemeProvider |
| @slayzone/tags | Tag | Tag CRUD | — |
| @slayzone/task | Task, schemas | Task CRUD, AI | TaskDetailPage, dialogs |
| @slayzone/task-browser | BrowserPanel types | — | BrowserPanel, device presets |
| @slayzone/task-terminals | TerminalTab types | terminal tabs handlers | TerminalContainer, useTaskTerminals |
| @slayzone/tasks | — | — | KanbanBoard, useTasksData |
| @slayzone/telemetry | Telemetry types | — | TelemetryProvider, track utils |
| @slayzone/terminal | TerminalMode, PtyInfo | PTY handlers | Terminal, PtyProvider |
| @slayzone/test-panel | TestProfile, TestCategory | test panel handlers | TestPanel, TestsTab |
| @slayzone/usage-analytics | UsageRecord, AnalyticsSummary | usage data handlers | UsageAnalyticsPage |
| @slayzone/worktrees | Worktree, DetectedWorktree | Git ops, worktree CRUD | GitPanel |

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

## Key Files

| File | Purpose |
|------|---------|
| `packages/apps/app/src/main/index.ts` | App entry, DI |
| `packages/apps/app/src/renderer/src/App.tsx` | Main React |
| `packages/domains/tasks/src/client/useTasksData.ts` | Core state |
| `packages/domains/terminal/src/main/pty-manager.ts` | PTY lifecycle |

## Terminal Modes

Builtin:
- `claude-code` - Claude Code CLI
- `codex` - OpenAI Codex CLI
- `gemini` - Google Gemini CLI
- `cursor-agent` - Cursor Agent
- `opencode` - OpenCode CLI
- `qwen-code` - Qwen Code
- `copilot` - GitHub Copilot

`terminal` - plain shell. Custom modes configurable via settings.

## Database

SQLite in user data. Schema: `packages/apps/app/src/main/db/migrations.ts`

## E2E Testing Rules

- **TDD**: Always run tests FIRST to see them fail, then fix code. Never write tests alongside code and assume they pass.
- **useRef + useEffect for DOM measurement**: If a component has early returns (loading/null guards) before the measured element, `useEffect([], [])` runs when the ref is still null. Use a **callback ref** instead.
- **Hook lifecycle across tabs**: Hooks' `useEffect` only runs on mount. Tabs stay mounted with `display: none` — seeding settings and navigating doesn't re-trigger effects. Test by opening a NEW task (fresh hook mount).
