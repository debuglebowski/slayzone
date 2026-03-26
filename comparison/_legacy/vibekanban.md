# VibeKanban

> Last evaluated: 2026-02-28
> Website: https://vibekanban.com
> GitHub: https://github.com/BloopAI/vibe-kanban
> Stars: ~22.1k
> License: Apache-2.0
> Company: Bloop AI (YC-backed)

## Summary

Open-source web-based AI agent orchestrator with kanban board, 10 agent integrations, git worktrees, code review, and built-in browser preview. Rust backend + React frontend, runs via `npx vibe-kanban`. Recently launched cloud/team tier ($30/user/mo). #1 competitor by traction in the orchestrator category.

## Datapoint Evaluation

| Feature | Verdict | Notes |
|---------|---------|-------|
| Kanban board | ✓ | Full kanban with 5 columns, drag-drop, tags, assignees, priorities, sub-issues |
| Local-first | ~ | Local mode stores data locally + works offline. But web-app arch, PostgreSQL, cloud is new default, local facing deprecation |
| MCP server | ✓ | Both MCP server (stdio, 12 tools) AND MCP client (connect external servers to agents) |
| Keyboard-driven | ~ | Cmd+K command bar with fuzzy search. No vim mode, no global hotkeys beyond Cmd+K and Cmd+Enter |
| All per task | ✗ | Features are per-workspace, not per-kanban-card. Must create workspace to get terminal/browser/editor |
| Terminal | ~ | xterm.js terminal in details sidebar. Per-workspace, not per-task. One terminal per workspace. Not a primary panel |
| Embedded browser | ~ | Dev server preview panel with device modes (desktop/mobile/responsive), Eruda DevTools, click-to-component. Iframe-based, only for dev servers, not arbitrary browsing |
| Code editor | ~ | Diff viewer (inline + side-by-side) with syntax highlighting + inline commenting. No editable code editor — review-only. VSCode Remote-SSH for actual editing |
| Git worktree isolation | ✓ | Auto-creates worktree per workspace in `.vibe-kanban-workspaces/`. Independent git state, auto-cleanup |
| Multi-provider AI agents | ✓ | 10 agents: Claude Code, Codex, Gemini CLI, Amp, Cursor CLI, OpenCode, Droid, Qwen Code, GitHub Copilot, Claude Code Router. All BYOK |

---

## Detailed Feature Analysis

### Kanban / Task Management

VibeKanban's core identity is its kanban board. Tasks (called "issues") flow through five columns: To Do, In Progress, In Review, Done, and Cancelled. The board supports drag-and-drop, tags, assignees, priorities, and sub-issues. Issues can link to multiple workspaces, and status updates automatically — moving to "In Progress" when a workspace launches, "In Review" when PRs open, and "Done" when all associated PRs merge.

The kanban + list dual view is available in the Cloud tier. Filtering and sorting are supported. The workflow is explicitly "Plan → Prompt → Review" — you create an issue on the board, then spin up a workspace to have an agent work on it. This is structurally similar to SlayZone's approach but with an important difference: in SlayZone, the task card IS the workspace (terminal + browser + editor embedded in the card), while in VibeKanban the kanban card and workspace are separate entities that must be linked.

Community feedback on the kanban approach is mixed. HN user **jjangkke** questioned whether kanban is the right UI given how quickly cards move with AI execution. The honest review at solvedbycode.ai noted that "creating a card, typing a description, assigning an agent, and managing the board" adds workflow friction for simple tasks.

Sources: [vibekanban.com/docs/cloud/kanban-board.md](https://vibekanban.com/docs/cloud/kanban-board.md), [vibekanban.com/docs/cloud/issues.md](https://vibekanban.com/docs/cloud/issues.md)

### Local-First Architecture

VibeKanban has a dual architecture: local mode and cloud mode. In local mode (`npx vibe-kanban`), data is stored on your machine in a PostgreSQL database, works offline, and requires no account. The Rust server and React frontend run locally and bind to a random free port.

However, VibeKanban is NOT local-first in the same way as SlayZone (SQLite file in user data dir). It's a web app that runs a server process — you access it via a browser tab, not a native window. The backend uses PostgreSQL with sqlx, which requires a running server process. If you kill the `npx` process, the UI disappears.

The Cloud tier launched February 3, 2026 with real-time sync powered by Electric SQL and TanStack DB. Cloud requires GitHub/Google authentication and internet. The migration path from local to cloud exists (`/migrate`), but the docs note local projects face **deprecation** in favor of cloud. This signals the company's direction is away from local-first.

Privacy controversy: early versions collected analytics (email addresses, GitHub usernames, task attempts, executor types, exit codes) via PostHog **without consent**. HN user **gpm** flagged this, and **arresin** said "I put devs who do this on a personal black list for life." The creator (louiskw) responded by making analytics opt-in. But trust damage persists in the community.

Sources: [vibekanban.com/docs/cloud/index.md](https://vibekanban.com/docs/cloud/index.md), [HN thread #44533004](https://news.ycombinator.com/item?id=44533004), [vibekanban.com/blog/introducing-vibe-kanban-cloud](https://www.vibekanban.com/blog/introducing-vibe-kanban-cloud)

### MCP Support

VibeKanban implements MCP in both directions — as server and client.

**MCP Server**: Exposed via `npx -y vibe-kanban@latest --mcp` (stdio transport). JSON configuration. 12 tools available:
- Project ops: `list_projects`, `list_repos`
- Context: `get_context` (active sessions only)
- Task management: `list_tasks`, `create_task`, `get_task`, `update_task`, `delete_task`
- Repository management: `get_repo`, `update_setup_script`, `update_cleanup_script`, `update_dev_server_script`
- Execution: `start_workspace_session` (accepts 9 executor types)

The MCP server is local-only — "cannot be accessed via publicly accessible URLs." This means external agents (Claude Desktop, etc.) can create tasks, move cards, read board status, and even start workspace sessions programmatically.

**MCP Client**: Agents within VibeKanban can connect to external MCP servers. Configuration via Settings → MCP Servers per agent. JSON format matching the standard `mcpServers` config. Examples: browser automation, Sentry, Notion. "Popular MCP servers" available for one-click install.

This dual MCP capability is genuinely strong — comparable to or slightly ahead of SlayZone's MCP server in terms of tool count.

Sources: [vibekanban.com/docs/integrations/vibe-kanban-mcp-server.md](https://vibekanban.com/docs/integrations/vibe-kanban-mcp-server.md), [vibekanban.com/docs/integrations/mcp-server-configuration.md](https://vibekanban.com/docs/integrations/mcp-server-configuration.md)

### Keyboard-Driven

VibeKanban provides a command bar (Cmd+K / Ctrl+K) with fuzzy search for actions. Available commands include workspace creation, PR creation, panel toggles, diff options, git operations (merge, rebase, push), and view management. Cmd/Ctrl+Enter sends messages.

However, the keyboard story is thin compared to SlayZone:
- **No global hotkeys** beyond Cmd+K and Cmd+Enter
- **No vim mode** or vim-style navigation
- **No numbered tab switching** (1-9)
- **No keyboard-first task creation** (must use command bar fuzzy match)
- **Mouse-first UI** — the kanban board, workspace panels, and most interactions are designed for mouse/trackpad
- The command bar is a good feature but it's a search-then-execute model, not a direct-shortcut model

No custom keybinding configuration documented. No keyboard shortcut reference page with full mappings (the docs page exists but only documents Cmd+K and Escape).

Sources: [vibekanban.com/docs/workspaces/command-bar.md](https://vibekanban.com/docs/workspaces/command-bar.md)

### Terminal

VibeKanban has a terminal in the Details Sidebar of the workspace interface, described as "full terminal emulation powered by xterm.js." Users can run commands directly within the workspace.

Key limitations vs SlayZone:
- **Per-workspace, not per-task**: The terminal belongs to the workspace, not the kanban card. You must create a workspace to get a terminal
- **Sidebar panel**: The terminal is in the details sidebar — a secondary panel, not a primary workspace area
- **One terminal per workspace**: No terminal splitting, no multiple terminal tabs within a workspace
- **No direct PTY per agent**: Agents communicate via the chat interface, not through a PTY. Agent output (thinking, file reads, code generation) streams in the chat panel. The sidebar terminal is separate from the agent
- **Auto-permission mode**: Uses `--dangerously-skip-permissions` or `--yolo` flags by default for agents, enabling command execution without approval. Users flagged security concerns for DevOps tasks
- **Logs panel**: Separate from the terminal — shows stdout/stderr from agent processes and dev servers

The terminal is functional but secondary. The primary interaction model is chat-first, not terminal-first.

Sources: [vibekanban.com/docs/workspaces/interface.md](https://vibekanban.com/docs/workspaces/interface.md), [vibekanban.com/docs/workspaces/chat-interface.md](https://vibekanban.com/docs/workspaces/chat-interface.md), [solvedbycode.ai/blog/vibe-kanban-honest-review](https://solvedbycode.ai/blog/vibe-kanban-honest-review)

### Embedded Browser

VibeKanban has a "Preview" panel in the workspace that functions as a dev server browser. Features include:
- **Dev server integration**: Configure `npm run dev` or similar; auto-detects localhost URLs
- **Device modes**: Desktop (full-width), Mobile (390×844 with device chrome), Responsive (draggable edges)
- **DevTools**: Powered by Eruda — Console, Elements, Network, Resources, Sources, Info tabs
- **Click-to-component**: Crosshair icon enables element inspection. Works with React, Vue, Svelte, Astro, plain HTML — no packages to install. Passes component details to chat as context
- **Navigation**: Back/forward buttons, URL bar, refresh, pause/resume dev server

Limitations vs SlayZone:
- **Iframe-based, not Chromium/WebView**: It's an iframe preview of the dev server, not a standalone browser
- **Dev servers only**: Cannot browse arbitrary URLs, documentation, PRs, or external sites
- **Per-workspace, not per-task**: Shared across the workspace, not embedded in each kanban card
- **No agent browser control**: The agent doesn't interact with the browser — it's a human QA tool
- **Requires dev build**: Click-to-component only works in development mode; production builds strip component metadata

The preview panel is genuinely useful for QA workflows but is not comparable to SlayZone's full Chromium WebView per task that can browse any URL.

Sources: [vibekanban.com/docs/browser-testing.md](https://vibekanban.com/docs/browser-testing.md), [vibekanban.com/docs/workspaces/interface.md](https://vibekanban.com/docs/workspaces/interface.md)

### Code Editor

VibeKanban does NOT have an integrated code editor. It has a **code review/diff viewer** in the Changes panel:
- **Diff modes**: Inline (interleaved) and side-by-side (split columns)
- **Syntax highlighting**: Green additions, red deletions, surrounding context
- **Inline commenting**: Hover line → click comment icon → write feedback → agent receives it
- **File tree**: Hierarchical navigation with expand/collapse, file search, quick expand/collapse
- **Customization**: Line wrapping, whitespace toggle, expand/collapse via command bar
- **GitHub PR integration**: Toggle PR comments inline with diffs, per-file comment badges

For actual code editing, VibeKanban relies on **external editors**:
- VSCode Remote-SSH integration: generates `vscode://vscode-remote/ssh-remote+...` URLs
- "Open in IDE" button in the context bar
- No built-in Monaco, CodeMirror, or similar editor component

The diff viewer is well-built for review workflows but the lack of an editable code editor means you always need a separate tool open. SlayZone's CodeMirror editor allows direct file editing within each task.

Sources: [vibekanban.com/docs/workspaces/changes.md](https://vibekanban.com/docs/workspaces/changes.md), [vibekanban.com/docs/integrations/vscode-extension.md](https://vibekanban.com/docs/integrations/vscode-extension.md)

### Git Worktree Isolation

This is one of VibeKanban's strongest features. When creating a workspace:
1. A git worktree is auto-created in `.vibe-kanban-workspaces/` (configurable in Settings)
2. A new branch is created based on your chosen target branch (naming: `vk/abc123-add-login-page`)
3. Setup scripts run automatically (e.g., `npm install`)
4. Each workspace maintains fully independent git state: working branch, target branch, commit history, staged/unstaged changes

Key details:
- **Automatic creation**: Worktrees are created when you create a workspace — no manual git commands needed
- **Storage**: `.vibe-kanban-workspaces/` directory, configurable
- **Isolation**: "Multiple workspaces modifying the same repository on different branches without conflicts"
- **Multi-repo**: A single workspace can contain multiple repositories, each with its own worktree
- **Cleanup**: Handles "orphaned and expired workspaces" (mentioned in README). Removing a repo from workspace "doesn't delete any code or branches"
- **No stashing needed**: "Switching between workspaces doesn't require stashing or committing"

Known issues (from community):
- Worktrees prevent file-level conflicts but NOT semantic/logical conflicts. HN user **akifq** reported agents "clobber each other when they touch the same files" — though this is about agents within the same workspace, not across workspaces
- The honest review noted: "When two agents modify the same system (authentication logic) differently, humans must reconcile semantic conflicts manually"

Comparable to SlayZone's worktree implementation. Both auto-create worktrees per task/workspace with isolated branches.

Sources: [vibekanban.com/docs/workspaces/creating-workspaces.md](https://vibekanban.com/docs/workspaces/creating-workspaces.md), [vibekanban.com/docs/workspaces/repositories.md](https://vibekanban.com/docs/workspaces/repositories.md), [GitHub README](https://github.com/BloopAI/vibe-kanban)

### Multi-Provider AI Agents

VibeKanban supports **10 coding agents**:

| Agent | Config Options |
|-------|---------------|
| Claude Code | Planning mode, router support, permission control, append_prompt |
| OpenAI Codex | Sandbox modes (read-only/workspace-write/danger-full-access), approval levels, reasoning effort (low/med/high) |
| Gemini CLI | Model variants (default/flash), confirmation bypass |
| Amp | Unrestricted action allowance |
| Cursor Agent CLI | Force execution, model specification |
| OpenCode (SST) | Model and agent type selection |
| Droid (Factory) | Autonomy levels (normal/low/med/high), reasoning depth |
| Qwen Code | Confirmation bypass |
| GitHub Copilot | Standard CLI setup |
| Claude Code Router | Multi-model orchestration across parallel instances |

**BYOK**: All agents use their own authentication. VibeKanban doesn't proxy API calls — each agent's CLI handles its own auth. No routing through VibeKanban servers.

**Agent profiles**: Create named configuration variants per agent. Clone existing configs. Set defaults. `append_prompt` parameter available for system prompt customization across agents.

**No local model support**: All supported agents are cloud-based CLI tools. No direct Ollama/llama.cpp integration (though agents like OpenCode may support local models independently).

This is the broadest agent support in the orchestrator category. SlayZone currently supports fewer agents (Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Grok) but both tools are BYOK and don't proxy API calls.

Sources: [vibekanban.com/docs/supported-coding-agents.md](https://vibekanban.com/docs/supported-coding-agents.md), [vibekanban.com/docs/settings/agent-configurations.md](https://vibekanban.com/docs/settings/agent-configurations.md)

---

## Pricing

| Plan | Price | Users | Features |
|------|-------|-------|----------|
| Free | $0/mo | 1 user | Core features, community support |
| Pro | $30/user/mo | 2-49 users | All Basic features, 99.5% SLA, Discord support |
| Enterprise | Custom | 50+ users | All Pro features, SSO/SAML, 99.9% SLA, dedicated Slack channel |

Free tier is fully functional for individual use. Pro is for team collaboration (shared projects, real-time sync). Self-hosting is available (Docker Compose) for all tiers.

Claims: "100,000 PRs created" and "30,000 active users" (from homepage, Feb 2026).

Sources: [vibekanban.com/pricing](https://vibekanban.com/pricing), [vibekanban.com/blog/introducing-vibe-kanban-cloud](https://www.vibekanban.com/blog/introducing-vibe-kanban-cloud)

## Community Sentiment

### What people love
- "Vibe kanban is the biggest increase I've had in productivity since cursor" — Growth lead at ElevenLabs ([vibekanban.com](https://www.vibekanban.com/))
- "feels like the same increase in productivity increase from when I first used Cursor" — HN user **lharries** ([HN #44533004](https://news.ycombinator.com/item?id=44533004))
- "I've been vibe coding at years for work as a manager. Great job, this is a game changer" — HN user **broast** ([HN #44533004](https://news.ycombinator.com/item?id=44533004))
- 80% of VibeKanban itself was built using Amp — **sqs** and **louiskw** ([HN #44533004](https://news.ycombinator.com/item?id=44533004))
- One developer reported "saving at least 30% of time on parallelizable tasks" ([solvedbycode.ai](https://solvedbycode.ai/blog/vibe-kanban-honest-review))

### Top complaints

1. **Privacy/telemetry betrayal** — Early analytics collected email, GitHub username, task attempts, executor types, exit codes WITHOUT consent. "I put devs who do this on a personal black list for life" — **arresin**. Now opt-in but trust damage lingers. ([HN #44533004](https://news.ycombinator.com/item?id=44533004))

2. **Excessive GitHub permissions** — OAuth requests "unlimited private access to ones repo. This is a hard NO from me" — **csomar**. Multiple users suggested using GitHub Apps for granular permissions. ([HN #44533004](https://news.ycombinator.com/item?id=44533004))

3. **Merge conflicts still happen** — "Vibe Kanban enables parallel execution but does not solve the logical problem of merge conflicts" — agents that both modify authentication logic differently require manual reconciliation. ([solvedbycode.ai](https://solvedbycode.ai/blog/vibe-kanban-honest-review))

4. **Hardware constraints** — "Running multiple agents on MacBook caused slowdowns after 4 concurrent tasks." Each agent consumes significant CPU/memory. ([solvedbycode.ai](https://solvedbycode.ai/blog/vibe-kanban-honest-review))

5. **"10X Productivity" misleading** — Realistic gains: 2-3X, not 10X. Assumes parallelizable tasks, powerful hardware, structured codebase, minimal merge review. ([solvedbycode.ai](https://solvedbycode.ai/blog/vibe-kanban-honest-review))

6. **Auto-permission security concern** — Uses `--dangerously-skip-permissions` / `--yolo` by default. "Users flagged security concerns for DevOps tasks." ([solvedbycode.ai](https://solvedbycode.ai/blog/vibe-kanban-honest-review))

7. **Workflow overhead for simple tasks** — "For small fixes like 'change button color,' direct Claude Code conversation remains faster" — kanban card creation adds friction. ([solvedbycode.ai](https://solvedbycode.ai/blog/vibe-kanban-honest-review))

8. **Windows issues** — "Multiple GitHub reports of Windows failures with default settings. Windows users should expect friction." ([solvedbycode.ai](https://solvedbycode.ai/blog/vibe-kanban-honest-review))

9. **Agent quality unaffected** — "Orchestration doesn't fix hallucinations or agent loops. Vibe Kanban cannot magically fix them. It only provides a better view to watch the crash happen." ([solvedbycode.ai](https://solvedbycode.ai/blog/vibe-kanban-honest-review))

10. **Not a real app** — "terminal windows and git worktrees" is essentially all it offers beyond UI chrome, per HN user **helsinki**. ([HN #44533004](https://news.ycombinator.com/item?id=44533004))

---

## Sources

### Official
- https://vibekanban.com/docs — Full documentation index
- https://github.com/BloopAI/vibe-kanban — Source code (Apache 2.0)
- https://vibekanban.com/pricing — Pricing page
- https://vibekanban.com/docs/browser-testing.md — Browser preview docs
- https://vibekanban.com/docs/integrations/vibe-kanban-mcp-server.md — MCP server docs
- https://vibekanban.com/docs/integrations/mcp-server-configuration.md — MCP client docs
- https://vibekanban.com/docs/supported-coding-agents.md — Agent list
- https://vibekanban.com/docs/settings/agent-configurations.md — Agent config details
- https://vibekanban.com/docs/workspaces/command-bar.md — Keyboard shortcuts
- https://vibekanban.com/docs/workspaces/changes.md — Code review/diff viewer
- https://vibekanban.com/docs/workspaces/creating-workspaces.md — Workspace creation + worktree
- https://vibekanban.com/docs/workspaces/repositories.md — Repository management
- https://vibekanban.com/docs/workspaces/interface.md — UI layout
- https://vibekanban.com/docs/workspaces/sessions.md — Sessions
- https://vibekanban.com/docs/workspaces/chat-interface.md — Chat/agent interaction
- https://vibekanban.com/docs/cloud/index.md — Cloud vs local
- https://www.vibekanban.com/blog/introducing-vibe-kanban-cloud — Cloud launch blog

### Community & Analysis
- https://news.ycombinator.com/item?id=44533004 — Show HN thread with 100+ comments
- https://solvedbycode.ai/blog/vibe-kanban-honest-review — In-depth honest review with pros/cons
- https://elite-ai-assisted-coding.dev/p/vibe-kanban-tool-review — Eleanor Berger tool review
- https://virtuslab.com/blog/ai/vibe-kanban/ — VirtusLab analysis

### Issues & Complaints
- HN #44533004 — Privacy/telemetry, GitHub permissions, agent quality skepticism
- solvedbycode.ai review — Hardware constraints, merge conflicts, Windows issues, auto-permission security

### Security
- No CVEs found. Telemetry privacy issue was the main security-adjacent concern (now resolved with opt-in).

### Press
- https://medium.com/@gokulofficial18602/im-about-to-try-vibe-kanban — Medium first impressions
- https://thamizhelango.medium.com/vibe-kanban-reimagining — Medium architecture overview

## Discrepancies with current table

1. **Local-first**: Table says ✗, should be **~** (partial) — local mode genuinely stores data locally, works offline, no account needed. But: web-app architecture (not desktop), PostgreSQL backend, company pushing toward cloud, local projects facing deprecation.

2. **Embedded browser**: Table says ✗, should be **~** (partial) — has dev server preview panel with device modes (desktop/mobile/responsive), Eruda DevTools (Console/Elements/Network/etc.), click-to-component inspection. Not a full Chromium browser and only for dev server preview, but significantly more than "no browser."
