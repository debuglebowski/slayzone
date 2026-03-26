# Superset.sh

> Last evaluated: 2026-02-28
> Website: https://superset.sh
> GitHub: https://github.com/superset-sh/superset
> Stars: ~2,300
> License: Elastic License v2 (ELv2) — **not OSS** despite Apache 2.0 claims on homepage/README
> Desktop: Electron 39 (macOS only, Windows/Linux planned)
> Version: v1.0.3

## Summary
Closest architectural match to SlayZone — Electron + xterm.js + Monaco + SQLite + browser pane + worktrees. Supports 8+ CLI agents. No kanban/task board (terminal multiplexer with workspace isolation, not PM). Cloud-synced tasks table via ElectricSQL. Founded by 3 ex-YC CTOs, bootstrapped, ~5 months old.

## Datapoint Evaluation

| Feature | Verdict | Notes |
|---------|---------|-------|
| Kanban board | ✗ | No visual kanban. Has cloud-synced tasks table (status, priority, assignee) + Linear integration. Table view, not board. |
| Local-first | ~ | Hybrid. Local SQLite for projects/workspaces. Cloud Neon PostgreSQL + ElectricSQL for tasks/orgs. Requires login — offline mode is open feature request. |
| MCP server | ✓ | Two MCP servers: `@superset/mcp` (17 tools, streamable HTTP) + `@superset/desktop-mcp` (9 browser automation tools, stdio). Also MCP client (disabled by default). |
| Keyboard-driven | ✓ | 80+ customizable shortcuts. No vim mode, no command palette. GUI-first Electron app with good shortcut coverage but mouse-driven sidebar. |
| Terminal | ✓ | Real PTY via xterm.js + node-pty. Dedicated daemon process for session persistence across crashes. Per-workspace terminals with split panes. |
| Embedded browser | ✓ | Electron Chromium webview. Workspace-scoped. Port forwarding integration (20 reserved ports per workspace). No DevTools, no mobile emulation, no agent control. |
| Code editor | ✓ | Monaco 0.55.1. Side-by-side/inline diffs. Hunk-level staging. File editing + discard. Positioned as review/staging tool, not IDE replacement. |
| Git worktree isolation | ✓ | Automatic on workspace creation (~2s). Configurable base dirs. Setup/teardown scripts. Port allocation per worktree. No hard capacity limit. |
| Multi-provider AI agents | ✓ | 7+ CLI agents: Claude Code, Codex, Gemini CLI, Cursor Agent, GitHub Copilot, OpenCode, Mastra Code. Plus built-in Mastra chat (Anthropic/OpenAI). All BYOK. |
| All per task | ✗ | Features are per-workspace (= per worktree/branch), not per task card. No task-scoped isolation concept. |

---

## Detailed Feature Analysis

### Kanban / Task Management

Superset does not ship a kanban board. The primary organizational unit is the **workspace**, which maps 1:1 to a Git worktree (isolated branch + working directory). Users create workspaces from branches, switch between them with `Cmd+1-9`, and monitor agent status from a sidebar. No drag-and-drop columns, no status swimlanes, no visual board.

However, Superset has a **cloud-synced tasks system** that is more substantial than it first appears. The PostgreSQL schema (synced via ElectricSQL) contains full `tasks` and `task_statuses` tables with fields for title, description, priority (`urgent`/`high`/`medium`/`low`/`none`), assignee, creator, labels, due dates, estimates, status (with color, type like "backlog", and position), branch association, PR URL, started/completed timestamps, and external integration fields. The desktop renderer has a `TasksTableView` component — suggesting a table-based task list view, not a kanban board. ([source: schema.ts](https://github.com/superset-sh/superset/blob/main/packages/local-db/src/schema/schema.ts))

The MCP package exposes `create_task`, `update_task`, `list_tasks`, `get_task`, `delete_task`, and `list_task_statuses` tools, allowing AI agents to programmatically manage tasks with priorities, assignees, and status transitions. ([source: packages/mcp/src/tools/index.ts](https://github.com/superset-sh/superset/blob/main/packages/mcp/src/tools/index.ts))

Superset also has an active **Linear integration** ([PR #1878](https://github.com/superset-sh/superset/pull/1878)) that syncs Linear issues as tasks, mirrors comments with author info, mirrors attachments with URL rewriting, and supports creating comments on Linear-integrated tasks from within Superset. The task schema includes `external_provider`, `external_id`, `external_key`, `external_url`, and `last_synced_at` fields.

Community feedback on HN did not specifically request kanban features — discussion centered on whether human review of 10+ parallel agents creates a bottleneck, infrastructure concerns about databases across worktrees, and skepticism about whether orchestrating many agents solves real problems vs burning tokens. ([HN thread](https://news.ycombinator.com/item?id=46368739))

**vs SlayZone**: SlayZone's kanban is the central UI — drag cards between columns, each card opens into a full isolated workspace. Superset's workspace list is flat (no visual status flow) and the tasks table is a secondary feature, not the primary organizing principle.

### Local-First Architecture

Superset implements a **two-tier database architecture** that is local-first in philosophy but requires cloud authentication to function.

**Local tier**: Uses **better-sqlite3** with **Drizzle ORM** for local state. The local SQLite database stores projects, workspaces, worktrees, settings, terminal presets, and browser history. This data never leaves the machine. Chat sessions persist locally in `~/.superset/chat-sessions/`. Source code stays entirely local — the privacy policy states: *"We do not have access to your source code, terminal commands, or file contents unless you explicitly choose to share diagnostic information."* ([privacy policy](https://superset.sh/privacy))

**Cloud tier**: Shared organizational data (tasks, task statuses, users, organizations, members, device presence, agent commands, integration connections, subscriptions) lives in **Neon PostgreSQL** and syncs to local SQLite via **ElectricSQL**. The sync works through Server-Sent Events (SSE) with JWT bearer auth. Flow: desktop subscribes via SSE → **Cloudflare Worker** (`electric-proxy`) validates JWT, extracts `organizationIds` → API injects organization-scoped `WHERE` clauses → Electric SQL streams changes → **TanStack Electric DB** updates local collections automatically. ([DeepWiki](https://deepwiki.com/superset-sh/superset))

They maintain 12 reactive Electric SQL collections: `tasks`, `taskStatuses`, `repositories`, `members`, `organizations`, `users`, `invitations`, `devicePresence`, `agentCommands`, `integrationConnections`, `subscriptions`. Collections cached per org for instant switching. Recently migrated from self-hosted Fly.io to Electric Cloud ([PR #1717](https://github.com/superset-sh/superset/pull/1717)), then reverted back to Fly.io ([PR #1720](https://github.com/superset-sh/superset/pull/1720)).

**Offline capability** is limited. Open feature request [#1722](https://github.com/superset-sh/superset/issues/1722): *"I'd love to still access my local worktrees even when I'm not logged in."* Confirms the app **requires authentication** to use, even for local worktree access. The architecture supports optimistic UI updates via Zustand stores, but the login gate is a significant limitation for true offline use.

**Encryption**: OAuth integration tokens encrypted at rest using AES-256-GCM with versioned `enc:v1:` payloads ([PR #1721](https://github.com/superset-sh/superset/pull/1721)). No database-level encryption for local SQLite.

**Telemetry**: Collects usage analytics (pages visited, features used, time spent), device identifiers, OS version. Recently added **PostHog** chat analytics and `panel_opened` events. Data shared with service providers for hosting, analytics, payment processing. ([privacy policy](https://superset.sh/privacy))

**vs SlayZone**: SlayZone is fully local — SQLite on disk, no account, no cloud sync, no telemetry. Works completely offline. Superset's "local-first" claim is misleading given the mandatory login and cloud sync dependencies.

### MCP Support

Superset has **two distinct MCP server packages** plus MCP client capabilities.

**`@superset/mcp` (cloud API MCP server)**: Located at `packages/mcp`, built on `@modelcontextprotocol/sdk`. Registers **17 tools** across three domains:

| Domain | Tools |
|--------|-------|
| Tasks | `create_task`, `update_task`, `list_tasks`, `get_task`, `delete_task`, `list_task_statuses` |
| Devices | `create_workspace`, `delete_workspace`, `get_app_context`, `get_workspace_details`, `list_devices`, `list_projects`, `list_workspaces`, `start_agent_session`, `switch_workspace`, `update_workspace` |
| Organizations | `list_members` |

Exposed at `/api/agent/mcp` as a **streamable HTTP endpoint** with Bearer auth. `create_task` accepts batch creation of 1-25 tasks with full metadata. ([PR #1858](https://github.com/superset-sh/superset/pull/1858))

**`@superset/desktop-mcp` (browser automation MCP server)**: Located at `packages/desktop-mcp`, named `"desktop-automation"` v0.1.0. Uses **stdio transport**. Registers 9 tools: `click`, `evaluate-js`, `get-console-logs`, `get-window-info`, `inspect-dom`, `navigate`, `send-keys`, `take-screenshot`, `type-text`. Exposes the Electron webview to AI agents. ([feature request #1801](https://github.com/superset-sh/superset/issues/1801))

**MCP Client**: Loads workspace MCP servers from `.mcp.json` or `.mastracode/mcp.json`. `/mcp` slash command shows configured servers with state badges. MCP tools surfaced as extra tools in Mastra chat sessions. **Currently disabled by default** behind env-gated kill switch `SUPERSET_CHAT_MASTRA_MCP_ENABLED=1` ([PR #1908](https://github.com/superset-sh/superset/issues/1908)), suggesting stability issues.

No **resource** or **prompt** support — only `tools` capability registered.

**vs SlayZone**: SlayZone's MCP server exposes task context (current task, project, status) so agents running inside a task can read their own context and update status. Superset's MCP focuses on workspace/device orchestration and cloud tasks — different design philosophy (orchestrate externally vs augment the agent's context).

### Keyboard-Driven

Superset documents **80+ customizable shortcuts** accessible via `Settings > Keyboard Shortcuts` (`Cmd+/`).

**Workspace Navigation**:
- `Cmd+1-9`: Switch to workspace 1-9
- `Cmd+Option+Up/Down`: Previous/next workspace
- `Cmd+N`: New workspace
- `Cmd+Shift+N`: Quick create workspace (from presets)
- `Cmd+Shift+O`: Open project

**Terminal Operations**:
- `Cmd+T`: New tab
- `Cmd+W`: Close pane/terminal
- `Cmd+D`: Split right
- `Cmd+Shift+D`: Split down
- `Cmd+K`: Clear terminal
- `Cmd+F`: Find in terminal
- `Cmd+Option+Left/Right`: Previous/next tab
- `Ctrl+1-9`: Open preset 1-9

**Layout Management**:
- `Cmd+B`: Toggle workspaces sidebar
- `Cmd+L`: Toggle changes panel
- `Cmd+O`: Open in external app
- `Cmd+Shift+C`: Copy path
- `Cmd+Shift+M`: Markdown reader mode

**Gaps**:
- **No vim mode**: No vim keybindings, emulation, or navigation anywhere
- **No command palette**: No `Cmd+P` fuzzy-finder for actions
- **Mouse-first design**: Sidebar workspace list, diff viewer, changes panel all primarily mouse-navigated. Context menus are right-click driven
- **Focus management bugs**: [#1790](https://github.com/superset-sh/superset/issues/1790) (keyboard focus not trapped in dialogs), [#1789](https://github.com/superset-sh/superset/issues/1789) (dialog focus from context menu)

The app is **keyboard-capable** (most actions have shortcuts, all customizable) but the interaction model is GUI-first Electron, not keyboard-first.

**vs SlayZone**: SlayZone is keyboard-first — single-letter shortcuts (N, K, J, I, E, G, T, B, S), Cmd+W cascading close (terminal → editor → browser → tab), full navigation without mouse. Both have extensive shortcuts, but SlayZone's design assumes keyboard-primary workflow.

### Terminal

Real PTY via **xterm.js 5.5.0 + node-pty 1.1.0-beta30** — same proven stack as VS Code and Hyper.

**Architecture standout**: Unlike most Electron terminal apps, Superset runs a **dedicated daemon process** (`terminal-host/index.ts`) that manages shell processes independently of the main Electron process. This provides session persistence across app crashes/restarts. Sessions persist to disk at `~/.superset/` with metadata (cwd, shell type, creation time). Founders confirmed on HN: *"a persistent daemon manages sessions so they survive crashes."* ([HN](https://news.ycombinator.com/item?id=46368739))

**Per-workspace terminals**: Each workspace gets its own terminal sessions — not global. Multiple tabs/panes per workspace. Split panes (Cmd+D right, Cmd+Shift+D down). Terminal presets configurable via `.superset/presets.json` — auto-configure pane layouts and startup commands. Ctrl+1-9 opens presets.

**Shell detection**: Auto-detects bash, zsh, fish. Custom prompt injection. Searchable transcripts per session. Scrollback rail for navigation.

**Sandboxing**: Superset itself does NOT sandbox agents — delegates to CLI agent permissions. Built-in Mastra chat has three permission modes (Auto, Semi-auto, Manual) but CLI agents use their own systems. No container/sandbox beyond git worktree isolation.

**Cloud terminals**: Not yet. Founders mentioned "cloud VM workspaces" on roadmap during HN discussion but not shipped.

**vs SlayZone**: Both use xterm.js + node-pty. Superset's daemon-based session persistence is genuinely better for crash recovery. SlayZone's terminals are per-task (scoped to a kanban card), Superset's are per-workspace (scoped to a worktree). SlayZone supports multiple terminal groups per task with named tabs.

### Embedded Browser

Built-in Chromium browser pane using Electron's webview. Toggle in **Settings > Behavior** routes chat links and terminal URLs to the built-in pane instead of system browser. Added around v0.0.86-v1.0.0 timeframe (Feb 2026).

**Port forwarding integration**: Each workspace gets 20 reserved ports (`SUPERSET_PORT_BASE + 0-19`). Browser pane previews services on these ports. Port visualization shows which services run from each worktree.

**Per-workspace**: Browser pane is workspace-scoped. Context menu added in v1.0.1. ([release notes](https://github.com/superset-sh/superset/releases/tag/desktop-v1.0.1))

**Limitations**: No evidence of agent-controllable browser, DevTools access, or mobile emulation. The `@superset/desktop-mcp` package (9 tools: click, evaluate-js, navigate, etc.) does expose the webview to agents, but this is a separate MCP server that must be explicitly connected. The browser pane itself appears to be a simple preview pane.

**vs SlayZone**: SlayZone's browser is per-task with multiple tabs, custom resolutions, and full Chromium DevTools. Superset's is per-workspace with port forwarding integration but no DevTools/emulation. SlayZone also supports persisting browser URLs per task.

### Code Editor

**Monaco Editor 0.55.1** — same engine as VS Code. Full language support, syntax highlighting.

**Diff viewer** is the core use case: side-by-side and inline diffs, review "500+ changed files across three branches simultaneously." Stage specific hunks, commit, push without leaving the app. v0.0.77 added diffs against base branch + ahead/behind status. v0.0.86 added file discard buttons for unstaged changes. ([releases](https://github.com/superset-sh/superset/releases))

**File editing**: Direct in-app via Monaco. Chat tool outputs show in a "changes pane" (v1.0.1). Clickable @file tags in chat. File drag-and-drop into chat.

**Accept/reject**: Hunk-level staging (cherry-pick changes). No inline accept/reject flow — it's git-native (stage/unstage/discard hunks), not AI-diff-specific.

**IDE integration**: Cmd+O opens workspace in external IDE (VS Code, Cursor, JetBrains, Xcode, Sublime, Terminal, Finder). Positioned as review/staging tool, not IDE replacement.

**vs SlayZone**: Both use capable editors (Monaco vs CodeMirror). SlayZone's editor is per-task, opens files from the worktree, syntax highlighted, and focused on reviewing agent changes in context. Superset's Monaco is more powerful as an editor but positioned as a diff review tool with explicit IDE-delegation philosophy.

### Git Worktree Isolation

**Automatic**: Creating a "workspace" in Superset automatically creates a git worktree. *"Each workspace represents an isolated development environment backed by a Git worktree — a separate working directory sharing the same `.git` folder."* Spins up in ~2 seconds. ([HN](https://news.ycombinator.com/item?id=46368739))

**Branch naming**: Auto-generates unique branch names from task descriptions. Can create from existing branches or PRs (v0.0.86: "use gh flows for PR discovery, creation, and checkout").

**Storage**: Configurable base directories via Settings > Behavior with per-project overrides (v0.0.88+). Default under `~/.superset/`.

**Setup/teardown scripts**: `.superset/config.json` defines scripts. Env vars injected: `SUPERSET_WORKSPACE_NAME`, `SUPERSET_ROOT_PATH`. Scripts can install deps, create database branches, launch Docker, copy .env files.

**Port allocation**: 20 consecutive ports per workspace to prevent conflicts.

**Capacity**: No hard limit. Port allocation (20 per workspace) is the practical constraint. Founders target "10+" but real-world is typically 2-3 complex + several smaller.

**Merge-back**: Git-native. Review diffs, stage hunks, commit, push. Create PRs via gh CLI. No custom merge UI.

**Known issues**: v0.0.77 reverted "clone local SQLite database when creating new worktree." Fix added for "git hook failures non-fatal during worktree creation." Branch cleanup on deletion is automatic with edge cases.

**LSP**: No built-in LSP. Superset is terminal-first; LSP happens in your external IDE. Monaco may provide basic IntelliSense.

**vs SlayZone**: Both auto-create worktrees. Superset's setup/teardown scripts and port allocation system are more mature. SlayZone stores worktrees inside `.worktrees/` in the project. Superset has configurable base dirs. Both handle cleanup on workspace/task deletion.

### Multi-Provider AI Agents

**Architecture**: Agent-agnostic terminal multiplexer. CLI agents run in terminal sessions with their own provider/model selection.

**Supported CLI agents** (with terminal presets):
| Agent | Notes |
|-------|-------|
| Claude Code | Primary agent |
| OpenAI Codex CLI | Supported |
| Cursor Agent | Added v0.0.81+ |
| Gemini CLI | Added with `-y` defaults |
| GitHub Copilot | Added v0.0.81+ |
| OpenCode | Supports 75+ providers including Ollama |
| Mastra Code | Added v1.0.1 |

**Built-in Mastra Chat**: Separate built-in chat powered by [Mastra](https://mastra.ai) framework:
- Anthropic models (Claude) — API keys enabled v1.0.3
- OpenAI models — added v0.0.86
- Anthropic OAuth for Claude Max subscribers (v0.0.85)
- Tool execution with permission modes (Auto/Semi-auto/Manual)
- MCP server integration

The Mastra chat is backed by a **Streams service on Fly.io** with durable sessions — chat messages DO leave your machine when using this feature.

**BYOK**: Yes for Mastra chat (provide Anthropic/OpenAI keys). CLI agents inherently BYOK. *"You use your own API keys directly with whatever AI providers you choose."* No routing through Superset servers for CLI agents. Mastra Streams on Fly.io does proxy for chat.

**Local models**: Not directly in Superset chat, but OpenCode (Ollama) work inside terminals.

**vs SlayZone**: Both support multiple CLI agents with BYOK. SlayZone integrates providers as first-class terminal modes (claude-code, codex, gemini, cursor, opencode, grok) with per-task provider config, persistent flags, and conversation IDs. Superset uses terminal presets — simpler but less integrated.

---

## Pricing

| Plan | Price | Notes |
|------|-------|-------|
| Free | $0 | Current homepage says "completely free and open source" |
| Pro | $20/seat/month | Mentioned in some sources, unclear what it unlocks vs free |
| AI costs | User pays providers | Direct BYOK, no credit system |

Hidden costs: Full cloud features require Neon PostgreSQL + Clerk accounts (their own pricing). Mandatory auth for basic usage.

---

## Community Sentiment

### What people love
- **Worktree isolation UX**: *"worktrees are a breeze, cmd + t auto opens Claude Code, you can view git changes within itself, closing a laptop doesn't kill the sessions"* — Twitter user via [superset.sh](https://superset.sh)
- **Agent-first design**: *"this agent first approach is really cool"* — eabnelson on [HN](https://news.ycombinator.com/item?id=46109015)
- **Switching from competitors**: *"used conductor since its inception but limited across many dimensions...switched to @superset_sh and haven't looked back"* — Twitter user
- **Daily driver adoption**: *"Just realized that I have done all my work in @superset_sh since Dec 26"* — Abhi Aiyer
- **Rapid release cadence**: 84 releases, near-daily updates during active dev

### Top complaints
1. **macOS-only** — [#405 Linux](https://github.com/superset-sh/superset/issues/405) and [#499 Windows](https://github.com/superset-sh/superset/issues/499) are most-upvoted issues
2. **Questionable value proposition** — ~50% of HN commenters skeptical. *"IDK what everyone is doing anymore. Just why do you need 10 parallel agents"* — xmonkee. *"Ah so now you can be a '10x' engineer -- 10x the cost with 0 to show"* — nickphx. ([HN](https://news.ycombinator.com/item?id=46368739))
3. **Human review bottleneck** — Multiple HN comments questioning whether parallelization converts "typing time" into "reading time" — amortka
4. **Electron overhead** — ~150MB RAM base footprint, users report 10+ worktrees "frying" machines ([Ry Walker](https://rywalker.com/research/superset))
5. **Cloud dependency** — Requires Neon + auth despite "local" marketing. *"I'd love to still access my local worktrees even when I'm not logged in"* ([#1722](https://github.com/superset-sh/superset/issues/1722))
6. **License misrepresentation** — README/homepage say "Apache 2.0" / "permissive open-source", actual license is ELv2 since [PR #1181](https://github.com/superset-sh/superset/pull/1181) (Feb 4, 2026). PR had empty description, no rationale. ELv2 prohibits hosted/managed service use — **not OSS by OSI definition**
7. **Small team (3 engineers)** — sustainability concern in space with well-funded competitors
8. **Zero Reddit presence** — Notable for 2.3k stars; growth concentrated in Twitter/Discord

### HN Show HN performance
- [Dec 2025](https://news.ycombinator.com/item?id=46109015): 24 points, 3 comments (positive)
- [Jan 2026](https://news.ycombinator.com/item?id=46368739): 96 points, 90 comments (~15% positive, ~35% neutral, ~50% skeptical)

---

## Sources

### Official
- https://superset.sh: Homepage
- https://superset.sh/privacy: Privacy policy
- https://superset.sh/team: Team page (3 ex-YC CTOs)
- https://superset.sh/changelog/2026-02-23-chat-overhaul-multi-agent-new-project: Changelog
- https://docs.superset.sh/overview: Documentation
- https://github.com/superset-sh/superset: GitHub repo

### Community & Analysis
- https://news.ycombinator.com/item?id=46368739: HN Show HN (96 pts, 90 comments)
- https://news.ycombinator.com/item?id=46109015: HN Show HN #1 (24 pts)
- https://deepwiki.com/superset-sh/superset: DeepWiki architecture analysis
- https://rywalker.com/research/superset: Ry Walker research
- https://rywalker.com/research/mac-coding-agent-apps: Mac Coding Agent Apps comparison (Tier 2)

### Issues & Complaints
- https://github.com/superset-sh/superset/issues/405: Linux support request
- https://github.com/superset-sh/superset/issues/499: Windows support request
- https://github.com/superset-sh/superset/issues/1722: Offline mode request
- https://github.com/superset-sh/superset/issues/769: Login failures
- https://github.com/superset-sh/superset/issues/1790: Focus management bugs

### Security
- https://github.com/superset-sh/superset/pull/1181: ELv2 license change (empty PR description, README still says Apache 2.0)
- https://github.com/superset-sh/superset/pull/1721: AES-256-GCM OAuth token encryption

### Press
- No significant press coverage found beyond HN submissions

## Discrepancies with current table
None — table is up to date. All current values accurate:
- Kanban ✗: No visual kanban board (tasks table exists but not a board)
- Local-first ~: Correct — hybrid architecture, requires login
- MCP ✓: Correct — two MCP servers with 26 combined tools
- Keyboard ✓: Defensible — 80+ customizable shortcuts (though GUI-first, no vim)
- Per task ✗: Correct — per-workspace, not per-task
- Terminal ✓: Correct — real PTY with daemon persistence
- Browser ✓: Correct — Electron Chromium webview
- Editor ✓: Correct — Monaco 0.55.1
- Worktrees ✓: Correct — automatic creation
- Multi-provider ✓: Correct — 8+ CLI agents + Mastra chat
