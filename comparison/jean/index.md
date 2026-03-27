---
name: Jean
slug: jean
status: active
last_checked: 2026-03-27

primary_category: desktop-dev-environment
secondary_categories:
  - agent-orchestrator

platforms:
  - macos
  - windows
  - linux
  # macOS fully tested + Homebrew cask. Windows/Linux builds available but less tested.

workflow_shape: workspace-first
deployment_model: local

provider_model:
  type: multi-provider
  byok: true
  local_models: false

license:
  type: open-source
  name: Apache 2.0

pricing:
  model: free
  summary: Completely free and open source. BYOK for AI provider subscriptions.

company:
  name: coolLabs Solutions Kft
  stage: bootstrapped
  funding: community-funded
  founder: Andras Bacsai

links:
  website: https://jean.build/
  github: https://github.com/coollabsio/jean
  discord: https://discord.com/invite/coollabs-459365938081431553

relevance:
  tier: core
  rationale: Closest structural overlap with SlayZone — native desktop, multi-agent, worktree-first, local-only. Ships the same terminal+agent pattern but without task management.

tags:
  - desktop-first
  - multi-agent
  - worktree-first
  - tauri
  - coolify-ecosystem
  - watch-closely

comparison_axes:
  kanban_board:
    verdict: no
    confidence: high
    note: No task board or kanban view. Sessions are organized by project, not by task status.
    source_ids:
      - github-readme
      - website-home
    last_checked: 2026-03-27

  real_terminal:
    verdict: yes
    confidence: high
    note: xterm.js integrated terminal with full PTY support.
    source_ids:
      - github-readme
    last_checked: 2026-03-27

  embedded_browser:
    verdict: no
    confidence: high
    note: Has a built-in HTTP server for remote web access, but no embedded browser pane in the app itself.
    source_ids:
      - github-readme
    last_checked: 2026-03-27

  code_editor:
    verdict: partial
    confidence: high
    note: CodeMirror 6 for file preview and diff viewing. Not a full editor — delegates to Zed, VS Code, Cursor, or Xcode via "open in editor".
    source_ids:
      - github-readme
    last_checked: 2026-03-27

  git_worktree_isolation:
    verdict: yes
    confidence: high
    note: Core feature. Automated worktree create, archive, restore, delete. PRs checked out as worktrees. Auto-archive on merge.
    source_ids:
      - github-readme
      - website-home
    last_checked: 2026-03-27

  mcp_client:
    verdict: unknown
    confidence: low
    note: No explicit MCP client documentation found. The product wraps CLI agents that may themselves act as MCP clients.
    source_ids:
      - github-readme
    last_checked: 2026-03-27

  mcp_server:
    verdict: yes
    confidence: medium
    note: MCP server support listed in README feature set.
    source_ids:
      - github-readme
    last_checked: 2026-03-27

  multi_provider_agents:
    verdict: yes
    confidence: high
    note: Wraps Claude CLI, Codex CLI, and OpenCode. Model selection includes Opus, Sonnet, Haiku. Thinking/effort level controls.
    source_ids:
      - github-readme
      - website-home
    last_checked: 2026-03-27

  local_first:
    verdict: yes
    confidence: high
    note: Everything runs locally. No cloud dependency. Optional remote access via built-in HTTP server.
    source_ids:
      - github-readme
    last_checked: 2026-03-27

  native_desktop:
    verdict: yes
    confidence: high
    note: Tauri v2 app (Rust backend + webview). macOS via Homebrew cask, Windows and Linux builds available.
    source_ids:
      - github-readme
    last_checked: 2026-03-27

  cli_companion:
    verdict: no
    confidence: high
    note: Desktop-only. No standalone CLI tool.
    source_ids:
      - github-readme
    last_checked: 2026-03-27

  issue_sync:
    verdict: no
    confidence: medium
    note: GitHub Issues/PRs can be investigated within the app, but no structured two-way sync with external trackers.
    source_ids:
      - github-readme
    last_checked: 2026-03-27

  pr_review_workflow:
    verdict: yes
    confidence: high
    note: Magic commands for code review with finding tracking, PR content generation, AI-powered commit messages.
    source_ids:
      - github-readme
    last_checked: 2026-03-27

  team_collaboration:
    verdict: no
    confidence: high
    note: Single-user tool. No shared workspaces or team features.
    source_ids:
      - github-readme
    last_checked: 2026-03-27

  mobile_remote:
    verdict: yes
    confidence: medium
    note: Built-in HTTP server with WebSocket and token auth. Accessible from phone via localhost, Cloudflare Tunnel, or Tailscale.
    source_ids:
      - github-readme
    last_checked: 2026-03-27

  oss_posture:
    verdict: yes
    confidence: high
    note: Fully open source under Apache 2.0.
    source_ids:
      - github-readme
    last_checked: 2026-03-27

assets:
  - path: assets/product-screenshot.png
    caption: Jean homepage showing worktree-centric workspace — project sidebar with worktree list, session counts, review status badges, and diff stats.
    proves: Confirms worktree-first design, session-based workflow, review status tracking, and multi-worktree project organization.
    source_url: https://jean.build/
    captured_on: 2026-03-27

sources:
  - id: website-home
    label: Jean homepage
    kind: official
    url: https://jean.build/

  - id: github-readme
    label: Jean GitHub repository and README
    kind: official
    url: https://github.com/coollabsio/jean

  - id: github-releases
    label: Jean releases
    kind: official
    url: https://github.com/coollabsio/jean/releases
---

# Jean

## Summary

Jean is a free, open-source native desktop environment for AI coding agents, built by the coolLabs team (creators of Coolify). It wraps Claude CLI, Codex CLI, and OpenCode in a Tauri v2 shell with first-class git worktree management. Pre-1.0 and iterating fast (v0.1.32 as of March 2026, ~715 GitHub stars).

## Positioning

Jean positions itself as "a dev environment for AI agents" — an opinionated desktop wrapper that unifies multiple CLI agents under one roof. It does not try to be an IDE or a project manager. The focus is on giving each agent session its own isolated workspace via git worktrees, with a lightweight code review and diff surface on top.

The product inherits community trust from Coolify, the team's established open-source PaaS. Jean is bootstrapped and community-funded, with no VC backing and no paid tier.

## Best-Fit User or Team

Solo developers who already use Claude Code or Codex from the terminal and want a native desktop shell that handles worktree lifecycle, session management, and model switching without switching to a full IDE. Developers in the Coolify ecosystem are a natural starting audience.

## Structured Feature Analysis

### Kanban / Task Board

No task board exists. Jean organizes work by project and session, not by task status. There is no drag-and-drop board, no status lanes, and no task lifecycle beyond the AI session itself.

### Real Terminal / PTY

xterm.js provides a full integrated terminal with PTY support. This is a core interaction surface — agent sessions run in real terminal panes.

### Embedded Browser

No embedded browser pane. Jean includes a built-in HTTP server for remote access to the app itself, but this is not an in-app browser for previewing web applications.

### Code Editor / Review Surface

CodeMirror 6 powers a file preview and diff viewer. Jean explicitly delegates full editing to external editors (Zed, VS Code, Cursor, Xcode) via an "open in editor" action. The code surface is review-oriented, not edit-oriented.

### Git Worktree Isolation

This is Jean's strongest differentiator. Worktree lifecycle is automated: create, archive, restore, delete. PRs are checked out as worktrees. Merged branches auto-archive. The product is built around the assumption that each agent session should have its own isolated working copy.

### MCP

Jean lists MCP server support in its feature set. MCP client behavior is unclear — the wrapped CLI agents (Claude Code, Codex) may themselves act as MCP clients, but Jean does not appear to add its own MCP client layer.

### Multi-Provider Agents

Supports Claude CLI, Codex CLI, and OpenCode as agent backends. Model selection includes Opus, Sonnet, and Haiku with thinking/effort level controls. The multi-agent story is a core selling point.

## Strengths

- Git worktree isolation is deeply integrated, not bolted on.
- Fully open source (Apache 2.0), no feature gates, no paid tier.
- Tauri v2 gives a lightweight native desktop feel without Electron overhead.
- Wraps multiple agent CLIs under one roof — not locked to one provider.
- Remote access via built-in HTTP server is a thoughtful addition for mobile/tablet use.

## Weaknesses

- No task management — no board, no status tracking, no issue sync.
- Pre-1.0 maturity (v0.1.x). Iterating fast but not production-hardened.
- Code editor surface is intentionally minimal — delegates to external editors.
- Single-user only. No team features.
- Small team (primarily one developer). Bus factor risk.
- No embedded browser for web app preview workflows.

## Pricing and Packaging

Completely free. Apache 2.0 licensed. No paid tiers, no usage limits, no telemetry gates. Users bring their own AI provider subscriptions (Anthropic, OpenAI, etc.).

## Community or Market Signal

~715 GitHub stars as of March 2026. The coolLabs Discord has ~20k members, but this is shared with Coolify — Jean-specific engagement is a subset. The product benefits from Andras Bacsai's reputation in the self-hosted open-source community. Early-stage but with a credible builder behind it.

## Why It Matters to SlayZone

Jean is the closest structural analog to SlayZone in the current landscape: native desktop, multi-agent, worktree-first, local-only. The key difference is that Jean has no task management layer — no kanban board, no status tracking, no issue sync. SlayZone's task-centric model is the primary differentiation axis.

Jean validates the thesis that developers want a dedicated desktop environment for AI agents rather than running CLI tools in a generic terminal. It also validates worktree isolation as a first-class workflow primitive. Where SlayZone should watch closely: Jean's remote access story and its lightweight Tauri footprint compared to Electron.

## Sources

- Source list lives in frontmatter for structure.
- Primary source is the GitHub README, which is comprehensive and current.
- The jean.build homepage provides high-level positioning but less technical detail than the repo.
