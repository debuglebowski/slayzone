---
name: VibeKanban
slug: vibekanban
status: active
last_checked: 2026-03-27

primary_category: agent-orchestrator
secondary_categories:
  - task-management

platforms:
  - web
  # Runs via `npx vibe-kanban`. Browser-based UI. Self-hostable via Docker Compose.

workflow_shape: workspace-first
deployment_model: hybrid
provider_model:
  type: multi-provider
  byok: true
  local_models: false

license:
  type: open-source
  name: Apache-2.0

pricing:
  model: freemium
  summary: Free for solo use. Pro $30/user/mo for teams (2-49). Enterprise custom (50+).

company:
  name: Bloop AI
  stage: startup
  funding: venture-backed
  # YC-backed

links:
  website: https://vibekanban.com
  docs: https://vibekanban.com/docs
  pricing: https://vibekanban.com/pricing
  github: https://github.com/BloopAI/vibe-kanban

relevance:
  tier: core
  rationale: Highest-traction open-source agent orchestrator with kanban board. Closest to SlayZone's board + agent + worktree positioning in the web-app space.

tags:
  - agent-orchestrator
  - kanban-native
  - browser-preview
  - watch-closely

comparison_axes:
  kanban_board:
    verdict: yes
    confidence: high
    note: Full kanban with 5 columns (To Do/In Progress/In Review/Done/Cancelled), drag-drop, tags, assignees, priorities, sub-issues. Board is the primary organizational surface.
    source_ids:
      - docs-kanban
      - docs-issues
    last_checked: 2026-02-28

  real_terminal:
    verdict: partial
    confidence: high
    note: xterm.js terminal in workspace details sidebar. Per-workspace, not per-task. One terminal per workspace. Secondary panel, not primary interaction surface. Agent output streams in chat, not terminal.
    source_ids:
      - docs-interface
      - docs-chat
    last_checked: 2026-02-28

  embedded_browser:
    verdict: partial
    confidence: high
    note: Dev server preview panel with device modes (desktop/mobile/responsive), Eruda DevTools, click-to-component. Iframe-based, dev servers only, not arbitrary URL browsing.
    source_ids:
      - docs-browser
      - docs-interface
    last_checked: 2026-02-28

  code_editor:
    verdict: partial
    confidence: high
    note: Diff viewer (inline + side-by-side) with syntax highlighting and inline commenting. Review-only, no editable code editor. Relies on VSCode Remote-SSH for actual editing.
    source_ids:
      - docs-changes
      - docs-vscode
    last_checked: 2026-02-28

  git_worktree_isolation:
    verdict: yes
    confidence: high
    note: Auto-creates worktree per workspace in `.vibe-kanban-workspaces/`. Independent git state per workspace. Multi-repo support. Auto-cleanup of orphaned worktrees.
    source_ids:
      - docs-workspaces
      - docs-repos
      - github-readme
    last_checked: 2026-02-28

  mcp_client:
    verdict: yes
    confidence: high
    note: Agents can connect to external MCP servers. Per-agent config via Settings. One-click install for popular servers.
    source_ids:
      - docs-mcp-client
    last_checked: 2026-02-28

  mcp_server:
    verdict: yes
    confidence: high
    note: Exposes MCP server via `npx -y vibe-kanban@latest --mcp` (stdio). 12 tools for project ops, task CRUD, workspace sessions. Local-only transport.
    source_ids:
      - docs-mcp-server
    last_checked: 2026-02-28

  multi_provider_agents:
    verdict: yes
    confidence: high
    note: 12+ agents -- Claude Code, Codex, Gemini CLI, Amp, Cursor CLI, OpenCode, Droid, Qwen Code, GitHub Copilot, Claude Code Router, Aider, Windsurf (latter two added since Feb 2026). All BYOK. Broadest agent support in the orchestrator category.
    source_ids:
      - docs-agents
      - docs-agent-config
    last_checked: 2026-02-28

  local_first:
    verdict: partial
    confidence: medium
    note: Local mode stores data locally via PostgreSQL, works offline, no account. But web-app architecture (browser tab, not native window), and company direction is toward cloud (local projects facing deprecation).
    source_ids:
      - docs-cloud
      - hn-thread
      - blog-cloud
    last_checked: 2026-02-28

  native_desktop:
    verdict: no
    confidence: high
    note: Web app accessed via browser tab. Runs a local Rust server process via `npx`. Not a native desktop app.
    source_ids:
      - docs-cloud
    last_checked: 2026-02-28

  cli_companion:
    verdict: partial
    confidence: medium
    note: MCP server can be invoked via CLI (`npx -y vibe-kanban@latest --mcp`). Not a standalone CLI workflow tool, but programmatic access exists.
    source_ids:
      - docs-mcp-server
    last_checked: 2026-02-28

  issue_sync:
    verdict: partial
    confidence: low
    note: MCP client can connect to external services (Notion, etc.) but no documented native two-way sync with Linear, Jira, or GitHub Issues.
    source_ids:
      - docs-mcp-client
    last_checked: 2026-02-28

  pr_review_workflow:
    verdict: yes
    confidence: high
    note: Diff viewer with inline commenting, GitHub PR integration, per-file comment badges, PR comments inline with diffs. Review is a core workflow step.
    source_ids:
      - docs-changes
    last_checked: 2026-02-28

  team_collaboration:
    verdict: yes
    confidence: medium
    note: Cloud tier ($30/user/mo) supports shared projects, real-time sync (Electric SQL + TanStack DB), team workspaces. Launched Feb 2026.
    source_ids:
      - pricing
      - blog-cloud
    last_checked: 2026-02-28

  mobile_remote:
    verdict: no
    confidence: medium
    note: No mobile app or remote companion documented. Web-based, so theoretically accessible from mobile browser but not designed for it.
    source_ids:
      - docs-cloud
    last_checked: 2026-02-28

  oss_posture:
    verdict: yes
    confidence: high
    note: Apache-2.0. Full source on GitHub. ~22k stars (as of Feb 2026). Self-hostable via Docker Compose.
    source_ids:
      - github-readme
    last_checked: 2026-02-28

assets:
  - path: assets/product-screenshot.png
    caption: VibeKanban homepage showing hero tagline, Plan/Prompt/Review workflow panels, GitHub star count, and supported agent logos.
    proves: Confirms product identity, kanban-first Plan/Prompt/Review workflow positioning, multi-agent support, and open-source traction (23.9k stars).
    source_url: https://vibekanban.com
    captured_on: 2026-03-27

sources:
  - id: docs-kanban
    label: Kanban board docs
    kind: official
    url: https://vibekanban.com/docs/cloud/kanban-board.md

  - id: docs-issues
    label: Issues and task management docs
    kind: official
    url: https://vibekanban.com/docs/cloud/issues.md

  - id: docs-interface
    label: Workspace interface layout
    kind: official
    url: https://vibekanban.com/docs/workspaces/interface.md

  - id: docs-chat
    label: Chat and agent interaction
    kind: official
    url: https://vibekanban.com/docs/workspaces/chat-interface.md

  - id: docs-browser
    label: Browser preview / dev server testing
    kind: official
    url: https://vibekanban.com/docs/browser-testing.md

  - id: docs-changes
    label: Code review and diff viewer
    kind: official
    url: https://vibekanban.com/docs/workspaces/changes.md

  - id: docs-vscode
    label: VSCode extension integration
    kind: official
    url: https://vibekanban.com/docs/integrations/vscode-extension.md

  - id: docs-workspaces
    label: Workspace creation and worktree setup
    kind: official
    url: https://vibekanban.com/docs/workspaces/creating-workspaces.md

  - id: docs-repos
    label: Repository management
    kind: official
    url: https://vibekanban.com/docs/workspaces/repositories.md

  - id: docs-mcp-server
    label: MCP server (stdio, 12 tools)
    kind: official
    url: https://vibekanban.com/docs/integrations/vibe-kanban-mcp-server.md

  - id: docs-mcp-client
    label: MCP client configuration
    kind: official
    url: https://vibekanban.com/docs/integrations/mcp-server-configuration.md

  - id: docs-agents
    label: Supported coding agents
    kind: official
    url: https://vibekanban.com/docs/supported-coding-agents.md

  - id: docs-agent-config
    label: Agent configuration and profiles
    kind: official
    url: https://vibekanban.com/docs/settings/agent-configurations.md

  - id: docs-cloud
    label: Cloud vs local architecture
    kind: official
    url: https://vibekanban.com/docs/cloud/index.md

  - id: docs-command-bar
    label: Command bar / keyboard shortcuts
    kind: official
    url: https://vibekanban.com/docs/workspaces/command-bar.md

  - id: pricing
    label: Pricing page
    kind: official
    url: https://vibekanban.com/pricing

  - id: github-readme
    label: GitHub repository (Apache-2.0)
    kind: official
    url: https://github.com/BloopAI/vibe-kanban

  - id: blog-cloud
    label: Cloud launch announcement (Feb 2026)
    kind: official
    url: https://www.vibekanban.com/blog/introducing-vibe-kanban-cloud

  - id: hn-thread
    label: Show HN thread (100+ comments)
    kind: community
    url: https://news.ycombinator.com/item?id=44533004

  - id: solvedbycode-review
    label: Honest review with pros/cons
    kind: analysis
    url: https://solvedbycode.ai/blog/vibe-kanban-honest-review

  - id: berger-review
    label: Eleanor Berger tool review
    kind: analysis
    url: https://elite-ai-assisted-coding.dev/p/vibe-kanban-tool-review

  - id: virtuslab-analysis
    label: VirtusLab analysis
    kind: analysis
    url: https://virtuslab.com/blog/ai/vibe-kanban/
---

# VibeKanban

## Summary

Open-source (Apache-2.0) web-based AI agent orchestrator with a full kanban board, 12+ coding agent integrations, automatic git worktree isolation, code review, and dev server browser preview. Rust backend + React frontend, runs locally via `npx vibe-kanban` or as a cloud team service. ~22k GitHub stars. Highest-traction product in the agent orchestrator category as of early 2026.

## Positioning

VibeKanban positions itself as a kanban-first agent orchestrator: plan tasks on a board, spin up isolated workspaces with agents, review diffs, merge PRs. The workflow is explicitly "Plan -> Prompt -> Review." It bridges project management and coding agent orchestration in a single surface -- the kanban board is not bolted on, it is the primary organizing abstraction.

The structural difference from SlayZone: in VibeKanban, the kanban card and workspace are separate entities that must be linked. In SlayZone, the task card IS the workspace (terminal + browser + editor embedded in the card).

## Best-Fit User or Team

Solo developers or small teams who want to run multiple coding agents in parallel across isolated workspaces, organized by a kanban board. Best for users comfortable with a browser-based workflow who prioritize broad agent support and open-source licensing over native desktop experience.

## Structured Feature Analysis

### Kanban / Task Board

Full kanban board with five columns (To Do, In Progress, In Review, Done, Cancelled), drag-and-drop, tags, assignees, priorities, and sub-issues. Status updates automatically -- moves to In Progress when a workspace launches, In Review when PRs open, Done when PRs merge. Kanban + list dual view available in Cloud tier.

Community feedback is mixed on whether kanban adds value when AI execution is fast enough to move cards through columns in minutes. The honest review at solvedbycode.ai noted that card creation adds workflow friction for simple tasks.

### Real Terminal / PTY

xterm.js terminal in the workspace details sidebar. Per-workspace, not per-task. One terminal per workspace. The terminal is a secondary panel -- agent output streams in the chat interface, not through the terminal PTY. Auto-permission mode (`--dangerously-skip-permissions` / `--yolo`) used by default for agents, which users flagged as a security concern.

### Embedded Browser

Dev server preview panel with device modes (desktop, mobile, responsive), Eruda DevTools (Console, Elements, Network, Resources, Sources, Info), and click-to-component inspection (React, Vue, Svelte, Astro, HTML). Iframe-based, dev servers only -- cannot browse arbitrary URLs. Per-workspace, not per-task. The agent does not interact with the browser directly; it is a human QA tool.

### Code Editor / Review Surface

Diff viewer (inline + side-by-side) with syntax highlighting and inline commenting. GitHub PR integration with inline comment badges. No editable code editor -- relies on VSCode Remote-SSH for actual editing. The diff viewer is well-built for review but means you always need a separate tool open for editing.

### Git Worktree Isolation

One of VibeKanban's strongest features. Auto-creates a worktree per workspace in `.vibe-kanban-workspaces/` (configurable). New branch created from chosen target branch. Setup scripts run automatically. Multi-repo support within a single workspace. Auto-cleanup of orphaned worktrees. No stashing needed when switching workspaces.

Known limitation: worktrees prevent file-level conflicts but not semantic/logical conflicts. Agents that modify the same system differently require manual reconciliation.

### MCP

Dual MCP support -- both server and client.

**Server**: 12 tools via `npx -y vibe-kanban@latest --mcp` (stdio transport). Project ops, task CRUD, repository management, and workspace session execution. Local-only transport.

**Client**: Agents connect to external MCP servers. Per-agent configuration. One-click install for popular servers (browser automation, Sentry, Notion).

This dual capability is genuinely strong and differentiating in the category.

### Multi-Provider Agents

12+ coding agents: Claude Code, OpenAI Codex, Gemini CLI, Amp, Cursor CLI, OpenCode, Droid, Qwen Code, GitHub Copilot, Claude Code Router, Aider, and Windsurf. All BYOK -- VibeKanban does not proxy API calls. Agent profiles allow named configuration variants with `append_prompt` for system prompt customization. Broadest agent support in the orchestrator category.

No local model support. All agents are cloud-based CLI tools.

## Strengths

- Full kanban board as the primary organizing surface, not an afterthought.
- Broadest coding agent support (12+ agents) of any orchestrator.
- Open-source (Apache-2.0) with ~23.9k GitHub stars (Mar 2026).
- Dual MCP support (server + client) is genuinely differentiating.
- Git worktree isolation is a core design primitive.
- Self-hostable. Free tier is fully functional for individuals.
- Active community with strong traction metrics (~30k users, ~100k PRs claimed).

## Weaknesses

- Web-app architecture (browser tab), not a native desktop app. No offline-first guarantees.
- Kanban card and workspace are separate entities -- friction to link them.
- Terminal is a sidebar secondary panel, not a primary interaction surface.
- No editable code editor -- must use external editor for changes.
- Browser preview is dev-server-only, not arbitrary URL browsing.
- Privacy trust damage from early non-consensual telemetry (now opt-in).
- Excessive GitHub OAuth permissions flagged by community.
- Auto-permission mode (`--yolo`) by default raises security concerns.
- Hardware constraints: slowdowns reported after 4+ concurrent agents on laptop.
- Company direction is toward cloud, with local mode facing deprecation signals.

## Pricing and Packaging

| Plan | Price | Scope |
|------|-------|-------|
| Free | $0/mo | 1 user, core features, community support |
| Pro | $30/user/mo | 2-49 users, team features, 99.5% SLA, Discord support |
| Enterprise | Custom | 50+ users, SSO/SAML, 99.9% SLA, dedicated Slack |

Free tier is fully functional for individual use. Self-hosting available (Docker Compose) for all tiers.

## Community or Market Signal

### What people praise
- "Biggest increase in productivity since Cursor" -- Growth lead at ElevenLabs.
- 80% of VibeKanban itself was built using Amp (sqs and louiskw on HN).
- ~30k active users and ~100k PRs created (homepage claims, Feb 2026).
- Strong HN reception (100+ comments on Show HN).

### Top complaints
1. **Privacy betrayal**: early telemetry collected email, GitHub username, task data without consent. "I put devs who do this on a personal black list for life." Now opt-in, but trust damage persists.
2. **GitHub permissions**: OAuth requests unlimited private repo access. Multiple users flagged as a hard no.
3. **Merge conflicts**: worktree isolation prevents file conflicts but not semantic conflicts across agents.
4. **Hardware constraints**: 4+ concurrent agents cause MacBook slowdowns.
5. **"10X" claim is misleading**: realistic gains are 2-3X, not 10X.
6. **Workflow overhead**: for simple tasks, direct CLI agent use is faster than creating a kanban card.
7. **Windows issues**: multiple GitHub reports of failures with default settings.

## Why It Matters to SlayZone

VibeKanban is the highest-traction open-source agent orchestrator and the closest competitor in the kanban + agent + worktree space. Key differentiation for SlayZone:

- **Task = workspace**: SlayZone embeds terminal, browser, and editor directly in each task card. VibeKanban requires linking separate kanban cards to workspaces.
- **Native desktop**: SlayZone is Electron-native. VibeKanban is a browser tab.
- **Full browser**: SlayZone has Chromium WebView per task for any URL. VibeKanban has iframe dev server preview only.
- **Terminal-first**: SlayZone's terminal is a primary panel with per-task PTY. VibeKanban's is a sidebar.
- **Local-first**: SlayZone uses SQLite in user data dir. VibeKanban uses PostgreSQL server process with cloud direction.

VibeKanban's advantages: broader agent support (10 vs fewer), dual MCP, open-source with strong traction, full kanban board with richer PM features, team collaboration tier.

## Sources

Source list lives in frontmatter. Key sources:
- Official docs for all product facts and feature details.
- GitHub repository for license, stars, and architecture.
- HN Show HN thread (#44533004) for community reception, privacy controversy, and permissions complaints.
- solvedbycode.ai honest review for realistic productivity assessment and known limitations.
