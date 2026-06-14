# Architecture

## Overview

SlayZone is an Electron desktop app organized as a **pnpm monorepo** following the Clara philosophy (see PHILOSOPHY.md).

```
┌─────────────────────────────────────────────────────────────┐
│                    Electron Main                             │
│  ┌─────────────┐  ┌─────────────────────────────────────┐   │
│  │   SQLite    │  │  Embedded @slayzone/server           │   │
│  │  (better-   │  │  terminal, task, projects, tags,     │   │
│  │  sqlite3)   │  │  settings                            │   │
│  └─────────────┘  └─────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │ tRPC v11 over WebSocket
┌────────────────────────────┴────────────────────────────────┐
│                    Electron Renderer                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Domain Clients                                       │   │
│  │  tasks (kanban), task (detail), terminal (xterm),     │   │
│  │  projects, settings, onboarding                       │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Package Structure

```
packages/
├── apps/
│   └── app/               # @slayzone/app - Electron shell
│       └── APP.md
├── domains/
│   ├── terminal/          # @slayzone/terminal - PTY, xterm
│   ├── task/              # @slayzone/task - Task CRUD, AI
│   ├── tasks/             # @slayzone/tasks - Kanban view
│   ├── projects/          # @slayzone/projects - Project CRUD
│   ├── tags/              # @slayzone/tags - Tag system
│   ├── settings/          # @slayzone/settings - Preferences
│   ├── onboarding/        # @slayzone/onboarding - Tutorial
│   └── worktrees/         # @slayzone/worktrees - Git worktrees
│       └── DOMAIN.md      # Each domain has DOMAIN.md
└── shared/
    ├── transport/         # @slayzone/transport - tRPC client/server routers
    ├── types/             # @slayzone/types - shared app/domain contracts
    ├── ui/                # @slayzone/ui - Radix/shadcn components
    └── editor/            # @slayzone/editor - Milkdown rich text
```

## Domain Structure

Each domain follows this pattern:

```
domain/
├── DOMAIN.md           # Domain documentation
└── src/
    ├── shared/         # Types, contracts (exported as ./shared)
    ├── server/         # Domain ops/routers/server integration
    └── client/         # React components, hooks (exported as ./client)
```

## Key Domains

| Domain | Purpose | Has Main? |
|--------|---------|-----------|
| terminal | PTY sessions, Claude Code/Codex/shell | ✓ |
| task | Task CRUD, detail view, AI description | ✓ |
| tasks | Kanban board, filtering | - |
| projects | Project management | ✓ |
| tags | Task tagging | ✓ |
| settings | Theme, preferences | ✓ |
| onboarding | Tutorial flow | - |
| worktrees | Git status, branch, worktrees | ✓ |

## Data Flow

Renderer data goes through `@slayzone/transport` tRPC. Electron preload is intentionally
bootstrap-only: server URL/mode, relaunch/settings for server mode, boot marks, and
native file path extraction for drag/drop or paste.

### Task Creation
```
CreateTaskDialog (task/client)
    ↓
getTrpcClient().task.create.mutate()
    ↓
@slayzone/transport over ws://127.0.0.1:<port>/trpc
    ↓
@slayzone/server task router → SQLite
    ↓
Response → useTasksData → KanbanBoard re-render
```

### Terminal Session
```
Terminal (terminal/client)
    ↓
getTrpcClient().pty.create.mutate({ taskId, cwd, mode })
    ↓
terminal/main/pty-manager.ts → node-pty spawn
    ↓
Mode adapter builds command
    ↓
PTY data streams → xterm.js renders
```

## Dependency Rules

1. **Apps** compose domains. No business logic.
2. **Domains** own their types in `shared/`. May depend on other domains.
3. **Shared packages** (ui, editor, types) are infrastructure. Never import domains.

Allowed domain dependencies:
```
task → terminal, worktrees (TerminalMode, GitPanel)
tasks → task, terminal (types, usePty)
transport → all renderer clients (tRPC contract)
```

## Logo & Icons

Z-slash logo in 2 places:
- `packages/apps/app/src/main/index.ts` - native splash screen (inline SVG)
- `packages/apps/app/src/renderer/src/assets/logo.svg` - React UI (`#e5e5e5` stroke)

Generated icons (in `packages/apps/app/`):
- `build/icon.{png,icns,ico}` - packaged app icons (macOS uses `build/icon.icns`)
- `resources/icon.png` - dev-mode Dock icon (`app.dock.setIcon(...)`)

To change the app icon:
1. Update the source logo/color in `scripts/generate-icons.js` (or replace `packages/apps/app/resources/icon.png` if you already have a final 512x512 PNG).
2. Run `node scripts/generate-icons.js` (writes to `packages/apps/app/build` + `packages/apps/app/resources`).
3. For dev mode, fully restart the app (`pnpm dev`) so the Dock icon refreshes.
4. For packaged builds, re-run the platform build (`pnpm build:mac`, `pnpm build:win`, etc.).
5. If macOS still shows the old icon, clear the icon cache:
   - `sudo rm -rf /Library/Caches/com.apple.iconservices.store`
   - `rm -rf ~/Library/Caches/com.apple.iconservices.store`
   - `killall Dock`
   - `killall Finder`

## Decision Log

| Decision | Rationale |
|----------|-----------|
| pnpm monorepo | Domain isolation, explicit deps |
| Per-domain shared/ | Types stay with domain logic |
| Dependency injection | Handlers receive ipcMain + db, testable |
| SQLite + better-sqlite3 | Cross-process, sync access |
| node-pty | Real PTY for Claude Code CLI |
| Clara philosophy | AI-comprehensible codebase structure |
| IPC→tRPC transport migration (8 slices) | Renderer transport is tRPC-over-WebSocket end to end. The preload bridge is bootstrap-only and must not grow: server URL/mode, relaunch/boot settings, boot marks, and native file-path extraction. Domain calls, browser/window/menu events, diagnostics, settings, terminal, and task data go through `@slayzone/transport`. REST remains only for CLI/MCP loopback APIs. Guard: `pnpm lint:window-api`. |
