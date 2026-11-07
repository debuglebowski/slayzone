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
│   ├── api/               # @slayzone/api - router composition (AppRouter), per-path policy tables, REST/MCP API, app-deps
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
    ├── transport/         # @slayzone/transport - tRPC client (+ scopes)
    ├── trpc-server/       # @slayzone/trpc-server - tRPC procedure builders + gate chain (domains build routers here; api composes)
    ├── types/             # @slayzone/types - shared app/domain contracts
    ├── ui/                # @slayzone/ui - Radix/shadcn components
    ├── theme-tokens/      # @slayzone/theme-tokens - theme presets as DOM-free data (desktop + mobile), theme choice, colour → hex
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
@slayzone/api task router (in the hub) → SQLite
    ↓
Response → useTasksData → KanbanBoard re-render
```

### Terminal Session
```
Terminal (terminal/client)
    ↓
getTrpcClient().pty.create.mutate({ taskId, cwd, mode })
    ↓
hub pty-manager (session record, mode adapter builds command, policy)
    ↓ pty.spawn {detection, relay}
computer: node-pty spawn → output pipeline (terminal query answers, detection,
          replay filter) → ring buffer (the ONLY scrollback)
    ↓ pty-signal events (state, prompt, title, dev URL, conversation id)
hub state machine mirrors them; pty.data relayed only while a client watches
    ↓
xterm.js renders (replay via pty.getReplay, then live, deduped by seq)
```

The hub never parses or buffers terminal output for a computer that runs the
pipeline (it acknowledges `detection` per session). Older computers, and retained
session hosts, fall back to the hub doing it as before. While a session's computer
is offline its scrollback is unavailable: clients show "Computer offline" and catch
up from their last seq on reconnect. Idle-close stays a hub decision over the
mirrored state.

### Task CLI on a computer

The computer gives each PTY or process a loopback CLI relay address and a session
capability. Task CLI requests travel over its existing authenticated WebSocket,
using bounded HTTP chunks with backpressure. The hub resolves the computer's
current owner, then applies the ordinary REST role and project ownership gates.
Capabilities expire with the spawned session; connection loss aborts in-flight
requests without replaying writes. Project path lookup uses that computer's
placements. Hub administration still requires an explicit user login.

`slay hub ls` shows local hubs and the task's hub target. `--json` retains the local
discovery array; `--json-v2` adds task-hub metadata in a versioned envelope.

### Direct client ↔ computer link

Desktop and mobile clients exchange terminal and chat data directly with the
computer that holds it. The hub gates once, when it issues a capability: it mints an
opaque token, registers only its SHA-256 on the computer over the computer's
authenticated link, and gives the client the token and the computer's advertised
authority. The client probes over HTTP and then opens the computer's `/direct/v1`
(tRPC over WebSocket). A computer with no listener the client can dial (a remote
one behind NAT) is reached over WebRTC instead: the hub brokers one SDP offer and
answer over the links it already has, and the same protocol runs on the data
channel — no open port, no server setup. Grants last 5 minutes and renew through the hub, so the hub
re-checks them. They are revoked when the account, the task, the computer or the
chat ownership changes.

The hub relays a session or chat tab only while a hub client watches it.
Computers still send every state signal, every direct keystroke's effects and a
summary of each saved chat event, so the hub's records, idle-close and attention
are unchanged. The relay stays as the fallback: a computer neither path reaches
(a strict firewall, offline; there is no TURN), an older hub or client, or a host
that installs no probe (the web shell). See [direct link](docs/direct-link.md).

### Computer-owned chat

Desktop/mobile requests pass through the hub's authorization and ownership gates
to the history-owning computer. Every computer, including the local one, runs an
independent chat transport, queue and per-hub SQLite database with immutable blobs.
Events, drafts, prompts, timelines, workspace diffs and new chat uploads persist
there before acknowledgement/display. The hub keeps opaque ownership/epoch,
session and artifact locators, lifecycle fences and transient relay data.

Changing task placement does not relocate chat history. Legacy cutover freezes
writers, streams/verifies data, commits ownership, waits for activation and then
cleans/compacts the source. Reconnect reconciles ownership, metadata and deletion
fences before admitting new work. Offline computers cause explicit unavailability.
General artifact originals and old hub backups remain documented exceptions;
unattributed legacy diagnostics remain held pending proven ownership.

Computer backups snapshot SQLite and referenced blobs together. Restores publish
separate read-only archives; provider session resumability is not guaranteed.
See [backup and restore](docs/backup-and-restore.md) for retention and operator details.

## Dependency Rules

1. **Apps** compose domains. No business logic.
2. **Domains** own their types in `shared/`. May depend on other domains.
3. **Shared packages** (ui, editor, types) are infrastructure. Never import domains.

Allowed domain dependencies:
```
task → terminal, worktrees (AgentId, GitPanel)
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
