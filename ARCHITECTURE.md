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

Computers keep their ptys when the hub restarts. The restarted hub adopts each
session its previous run left running into its tab (`pty.adopt`, or `adoptLive` on
the tab's own start) instead of starting or replacing one; what it cannot adopt
stays running and is listed for the user to attach or stop (terminal DOMAIN.md,
"Hub restart: adopt, else surface").

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

### Client ↔ hub versions

A remote hub and its apps (desktop, web shell, mobile) update independently, so
each side checks the other before relying on it. One file holds the contract,
`packages/shared/trpc-server/src/api-version.ts`. `HUB_API_VERSION` is the API's
version. `MIN_CLIENT_API` is the oldest app a hub serves, and `MIN_HUB_API` is the
oldest hub an app works with. `HUB_FEATURES` lists the optional features an app
checks with `hubHasFeature` before using them.

- Every app socket names its version in the url (`?clientApi=N`). A hub refuses an
  app below its minimum on every call with `CLIENT_TOO_OLD`.
- `hub.describe` stays open to every version and reports `api` and `features`. It
  is the contract's anchor: its fields are never removed.
- An app finds a hub below its minimum, or one that no longer serves it, in that
  answer. That hub gets one banner ("needs update" or "update SlayZone") and a
  status in Settings → Hubs, and `hubCompatLink` sends it nothing else. A call to a
  procedure an older hub lacks fails as "update the hub", not as a bare NOT_FOUND.
- `pnpm check:api-compat` (CI, and `release:tag`) compares HEAD's tRPC API with the
  latest release's in both directions, inputs and outputs, at the type level. It
  fails on a break the minimums do not exclude, unless
  `packages/apps/api/api-compat.json` accepts it with a reason. So a change stays
  additive, is gated by a feature, is accepted, or narrows the window.

Not covered yet: the CLI's REST routes. Hub ↔ computer has its own strict
`COMPUTER_PROTOCOL_VERSION` plus auto-upgrade.

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
| IPC→tRPC transport migration (8 slices) | Renderer transport is tRPC-over-WebSocket end to end. The preload bridge carries only bootstrap and client-local host work, never domain calls: server URL/mode, relaunch/boot settings, boot marks, native file-path extraction, and work that must happen on the device the person uses whatever hub it talks to (direct-link preparation; artifact PDF/PNG/HTML export, which the desktop renders offscreen and the web shell prints through the browser; saving artifact file/folder/zip downloads, whose bytes the client read from the hub). Each such capability is optional on the contract (`electron-bootstrap-contract.ts`) and read through `electronBootstrap` with a fallback. Domain calls, browser/window/menu events, diagnostics, settings, terminal, and task data go through `@slayzone/transport`. REST remains only for CLI/MCP loopback APIs. Guard: `pnpm lint:window-api`. |
| Task panel model | A task's panels are a layout of columns of tab groups (`tasks.panel_layout`), every panel type with any number of instances; layout ops are pure (`@slayzone/task-contracts` `layout/`) so the task view, the hub and `/api/tasks/:id/layout` + `/panels` (`slay panels layout …`) apply the same ones. Saved layouts (built-in Classic and others, the user's own) live in the per-user `task_layouts` setting; switching parks live panels instead of destroying them. Classic is derived from the legacy `panel_visibility`/`panel_sizes`/`panel_config` and the hub dual-writes those columns on every layout write, so older apps keep working (they see primaries only). See docs/plans/panel-model.md. |
| Sidebar lenses | A lens is a saved preset of the tree sidebar (grouping, row look, projects, Needs-you strip, display settings) in the `viewState` slice (`@slayzone/tabs-state` `lenses.ts`). The sidebar reads only the live `tree*` fields: applying a lens writes them, saving copies them back, "unsaved" means they differ — so the sidebar has one source of truth and the old global display settings became the first lens on upgrade. |
| Client-local browser panel | The browser panel's web views live on the client (Electron main) and the panel drives them directly over the preload's generic `window.api.browserHost` (`invoke` + `on`; typed by `@slayzone/task-browser/shared` `BrowserHostMethods`). The hub never touches a live view: it stores the tab list (`tasks.browser_tabs`) and runs `app.browserRelay` — which client owns a task's live tabs (the one used last) and a request/reply channel the REST `/api/browser/*` routes (`slay browser`) ride to reach it. Results return as values: `slay browser screenshot` gets the PNG bytes and the CLI writes the file on its own machine; the hub writes nothing. The panel's camera button captures on the client's host (`view.captureToTempFile`). Same on a local and a remote hub; no `/cap` involved. |
