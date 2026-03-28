---
name: Aperant (formerly Auto-Claude)
slug: auto-claude
status: active
last_checked: 2026-03-28

primary_category: agent-orchestrator
secondary_categories:
  - desktop-environment

platforms:
  - macos
  - windows
  - linux

workflow_shape: board-first
deployment_model: local
provider_model:
  type: multi-provider
  byok: true
  local_models: false
  # Core loop depends on Claude Code CLI. OpenRouter adds alternative LLM/embedding providers.
  # Local model support partially available via OpenRouter-compatible endpoints.

license:
  type: copyleft
  name: AGPL-3.0
  # Changed from MIT to AGPL-3.0 during the Aperant rebrand (March 2026).
  # Commercial licensing available for closed-source use cases.

pricing:
  model: free-transitioning
  summary: Currently free and open-source under AGPL-3.0. Paid tiers (Pro, Team, Enterprise) announced but not yet priced. Requires external Claude Pro/Max subscription for core agent loop.

company:
  name: Mikalsen AI AS
  stage: startup
  funding: unknown
  # Norwegian company (Org.nr 932 254 026). Solo-founded by AndyMik90.

launch_year: 2025
github_stars: 14000
contributors: 73

links:
  website: https://aperant.com
  github: https://github.com/AndyMik90/Aperant
  github_legacy: https://github.com/AndyMik90/Auto-Claude
  discord: https://discord.gg/QhRnz9m5HE
  changelog: https://github.com/AndyMik90/Aperant/blob/develop/CHANGELOG.md
  releases: https://github.com/AndyMik90/Aperant/releases

relevance:
  tier: core
  rationale: Closest board-first agent orchestrator competitor. Shares kanban + parallel agents + worktree isolation positioning with SlayZone, but Claude-centric and lacks embedded browser/editor depth.

tags:
  - desktop-first
  - multi-agent
  - claude-centric
  - board-first
  - watch-closely

comparison_axes:
  kanban_board:
    verdict: yes
    confidence: high
    note: Native kanban board with columns (Planning, In Progress, AI Review, Human Review, Done). Drag-and-drop task reordering added in v2.7.5. Queue System v2 with smart task prioritization and auto-promotion. Core product surface, not an afterthought.
    source_ids:
      - github-readme
      - releases-v2.7.5
      - releases-v2.7.6
    last_checked: 2026-03-28

  real_terminal:
    verdict: yes
    confidence: high
    note: Real PTY execution with up to 12 parallel agent terminals. Customizable terminal fonts, one-click task context injection. Terminal reliability is an ongoing focus area with GPU context and process cleanup fixes.
    source_ids:
      - github-readme
      - releases-v2.7.6
      - releases-v2.7.4
    last_checked: 2026-03-28

  embedded_browser:
    verdict: no
    confidence: high
    note: No embedded browser pane per task. Browser-tool references exist inside agent QA flows, but no persistent in-app browsing workspace for users.
    source_ids:
      - github-readme
      - website
    last_checked: 2026-03-28

  code_editor:
    verdict: partial
    confidence: medium
    note: File explorer, files tab in task detail, and diff/summary review surface. Not a full IDE-grade embedded editor — positioned for review and file management rather than deep editing workflows.
    source_ids:
      - github-readme
      - releases-page-2
    last_checked: 2026-03-28

  git_worktree_isolation:
    verdict: yes
    confidence: high
    note: Core design primitive. Isolated workspaces using git worktrees protect main branch during development. Worktree recovery manager, stale cleanup, searchable branch combobox, and async parallel worktree operations (v2.7.6). Actively maintained reliability area.
    source_ids:
      - github-readme
      - releases-v2.7.5
      - releases-v2.7.6
    last_checked: 2026-03-28

  mcp_client:
    verdict: yes
    confidence: high
    note: Dynamic MCP tool injection, Electron MCP support, MCP profile manager for configuring toolsets at runtime. v2.8.0-beta.6 includes @ai-sdk/mcp package in production builds.
    source_ids:
      - releases-page-3
      - releases-v2.7.5
      - changelog-beta
    last_checked: 2026-03-28

  mcp_server:
    verdict: partial
    confidence: medium
    note: A third-party MCP server (ForITLLC/auto-claude-mcp) exposes Auto-Claude functionality to Claude Code and other MCP clients (list_specs, batch_status, review_spec, merge_worktree). Not an official first-party feature.
    source_ids:
      - third-party-mcp
    last_checked: 2026-03-28

  multi_provider_agents:
    verdict: partial
    confidence: medium
    note: Claude Code remains the core agent engine requiring Claude Pro/Max subscription. OpenRouter support added in v2.7.2 for alternative LLM and embedding providers. Custom Anthropic-compatible API endpoints supported. Community reports show OpenRouter routing to GPT, Qwen, Gemini models. Not yet fully frictionless multi-provider everywhere.
    source_ids:
      - releases-v2.7.2
      - issue-1144
      - issue-446
    last_checked: 2026-03-28

  local_first:
    verdict: partial
    confidence: high
    note: Local Electron desktop app with local memory persistence under ~/.auto-claude/memories/. But core coding loop depends on Claude Code CLI + Anthropic API auth. Optional remote memory sync service. Best described as local-heavy but cloud-dependent for agent intelligence.
    source_ids:
      - github-readme
      - releases-v2.7.3
    last_checked: 2026-03-28

  native_desktop:
    verdict: yes
    confidence: high
    note: Electron app shipped for macOS (Apple Silicon + Intel), Windows (x64), and Linux (AppImage, Debian, Flatpak). Auto-update capability. Code-signed on macOS.
    source_ids:
      - github-readme
      - releases-v2.7.6
    last_checked: 2026-03-28

  cli_companion:
    verdict: no
    confidence: medium
    note: No separate companion CLI. The product wraps Claude Code CLI but does not expose its own CLI interface.
    source_ids:
      - github-readme
    last_checked: 2026-03-28

  issue_sync:
    verdict: partial
    confidence: medium
    note: GitHub and GitLab integration for issue import, investigation, and MR creation. Linear task synchronization listed as a feature. Aperant website roadmap includes Jira integration. Depth of two-way sync not fully documented.
    source_ids:
      - github-readme
      - website
    last_checked: 2026-03-28

  pr_review_workflow:
    verdict: yes
    confidence: high
    note: PR review validation pipeline with context enrichment. AI-powered PR template generation. Bulk select and create PR functionality for Human Review column. Evidence-based PR validation system added in v2.7.6.
    source_ids:
      - releases-v2.7.5
      - releases-v2.7.6
    last_checked: 2026-03-28

  team_collaboration:
    verdict: no
    confidence: medium
    note: Currently single-user. Team workspaces, shared memory, real-time collaboration, RBAC, and SSO/SAML listed on aperant.com pricing roadmap but not yet shipped.
    source_ids:
      - website
    last_checked: 2026-03-28

  mobile_remote:
    verdict: no
    confidence: medium
    note: No mobile access today. Listed on aperant.com pricing roadmap under Enterprise tier.
    source_ids:
      - website
    last_checked: 2026-03-28

  oss_posture:
    verdict: yes
    confidence: high
    note: Fully open-source under AGPL-3.0 (changed from MIT during Aperant rebrand). Commercial licensing available for closed-source use cases. 14k GitHub stars, 73 contributors.
    source_ids:
      - github-readme
      - website
    last_checked: 2026-03-28

assets:
  - path: assets/aperant-kanban-board.png
    caption: Aperant kanban board with Planning, In Progress, AI Review, Human Review, and Done columns.
    proves: Confirms native kanban board is a core product surface with task cards, status columns, and agent assignment.
    source_url: https://github.com/AndyMik90/Aperant
    captured_on: 2026-03-28

  - path: assets/aperant-agent-terminals.png
    caption: Six parallel agent terminals running simultaneously.
    proves: Confirms real multi-agent terminal execution with parallel task processing.
    source_url: https://github.com/AndyMik90/Aperant
    captured_on: 2026-03-28

  - path: assets/aperant-homepage-hero.png
    caption: Aperant website hero with tagline and product UI mockup.
    proves: Confirms rebrand from Auto-Claude to Aperant and current product positioning.
    source_url: https://aperant.com
    captured_on: 2026-03-28

sources:
  - id: github-readme
    label: Aperant GitHub README (formerly Auto-Claude)
    kind: official
    url: https://github.com/AndyMik90/Aperant

  - id: website
    label: Aperant product website
    kind: official
    url: https://aperant.com

  - id: releases-v2.7.6
    label: v2.7.6 release notes (latest stable, Feb 2026)
    kind: official
    url: https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.6

  - id: releases-v2.7.5
    label: v2.7.5 release notes
    kind: official
    url: https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.5

  - id: releases-v2.7.4
    label: v2.7.4 release notes
    kind: official
    url: https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.4

  - id: releases-v2.7.3
    label: v2.7.3 release notes (memory architecture)
    kind: official
    url: https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.3

  - id: releases-v2.7.2
    label: v2.7.2 release notes (OpenRouter support)
    kind: official
    url: https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.2

  - id: releases-page-2
    label: Older releases page
    kind: official
    url: https://github.com/AndyMik90/Auto-Claude/releases?page=2

  - id: releases-page-3
    label: Earlier releases page (MCP features)
    kind: official
    url: https://github.com/AndyMik90/Auto-Claude/releases?page=3

  - id: changelog-beta
    label: v2.8.0-beta.6 changelog entry
    kind: official
    url: https://github.com/AndyMik90/Aperant/blob/develop/CHANGELOG.md

  - id: issue-1144
    label: "Issue #1144: 3rd-party provider support (closed/completed)"
    kind: community
    url: https://github.com/AndyMik90/Aperant/issues/1144

  - id: issue-446
    label: "Issue #446: OpenRouter model preference bug"
    kind: community
    url: https://github.com/AndyMik90/Auto-Claude/issues/446

  - id: third-party-mcp
    label: ForITLLC auto-claude-mcp server (third-party)
    kind: community
    url: https://github.com/ForITLLC/auto-claude-mcp

  - id: hn-launch
    label: Show HN launch discussion
    kind: community
    url: https://news.ycombinator.com/item?id=45149602

  - id: reddit-experience
    label: Reddit user experience thread
    kind: community
    url: https://www.reddit.com/r/ClaudeAI/comments/1n9hycb/is_autoclaude_getting_better/
---

# Aperant (formerly Auto-Claude)

## Summary

Aperant is an Electron desktop app that wraps Claude Code into a visual kanban-based orchestrator for parallel AI coding tasks. It positions itself as "the world's first AI coding platform that builds, ships, and maintains your product" — covering the full software lifecycle from planning through maintenance. Rebranded from Auto-Claude in March 2026, the project has grown from 3.6k to 14k GitHub stars and shifted from MIT to AGPL-3.0 licensing as the team prepares commercial tiers.

## Positioning

Aperant is a board-first agent orchestrator. The core loop is: describe tasks on a kanban board, agents plan/build/test in isolated worktrees, human reviews and merges. It aims to be the coordination layer on top of Claude Code rather than a replacement for it. The Aperant rebrand signals ambitions beyond Claude-only orchestration toward full lifecycle product development including autonomous maintenance, issue triage, and deployment.

The aperant.com website positions aggressively against Copilot/Cursor/Devin with "AI can write code. But code isn't a product" messaging. Planned paid tiers (Pro, Team, Enterprise) will add collaboration, analytics, and infrastructure features.

## Best-Fit User or Team

Solo developers or small teams who already use Claude Code and want to parallelize multiple coding tasks with visual coordination. Particularly strong for users who work on feature branches in parallel and need worktree isolation without manual git management. The non-coder testimonials on aperant.com suggest it also targets technical founders who want to ship products without deep coding skills.

## Structured Feature Analysis

### Kanban / Task Board

Full kanban board with five columns: Planning, In Progress, AI Review, Human Review, Done. Drag-and-drop reordering added in v2.7.5. Queue System v2 (v2.7.6) adds smart task prioritization with auto-promotion from Planning to In Progress. This is the primary product surface — Aperant is a board that orchestrates agents, not an agent with a board bolted on.

### Real Terminal / PTY

Up to 12 parallel agent terminals with real PTY execution. One-click task context injection spawns agents into isolated worktree directories. Terminal reliability is an ongoing engineering focus: v2.7.6 addressed GPU context exhaustion, macOS shutdown crashes, and orphaned agent management during extended builds. Customizable fonts with OS-specific defaults (v2.7.4).

### Embedded Browser

No embedded browser pane. Browser-tool references exist inside agent QA/tool-selection flows, but there is no persistent in-app browsing workspace for users. This is a clear gap versus SlayZone.

### Code Editor / Review Surface

File explorer and files tab in task detail view, with diff and summary review improvements in recent releases. Positioned for review and file management rather than deep editing. Not a full IDE-grade embedded editor — no documented accept/reject patch flow, conflict resolution UX, or multi-file editing workflow.

### Git Worktree Isolation

Core design primitive and one of Aperant's strongest features. Each task runs in an isolated git worktree protecting the main branch. Worktree recovery manager handles stale cleanup. v2.7.5 added searchable branch combobox for worktree creation. v2.7.6 moved to async parallel worktree operations to prevent UI freezing. AI-powered merge conflict resolution is a documented capability.

### MCP

Strong MCP client posture with dynamic tool injection, Electron MCP support, and a profile manager for runtime toolset configuration. The v2.8.0-beta.6 includes `@ai-sdk/mcp` in production builds. A third-party MCP server (ForITLLC/auto-claude-mcp) exposes Aperant functionality to external clients, but this is not an official first-party feature.

### Multi-Provider Agents

Claude Code remains the required core engine (Claude Pro/Max subscription needed). OpenRouter support (v2.7.2) adds alternative LLM and embedding providers — community reports show routing to GPT, Qwen, Gemini models via OpenRouter. Custom Anthropic-compatible API endpoints supported. Local model support partially available through compatible endpoints. Materially beyond Claude-only, but not yet fully frictionless multi-provider.

## Strengths

- Board-first orchestration with real kanban workflow is a genuine differentiator among agent tools.
- Git worktree isolation is deeply integrated and actively maintained, not a marketing checkbox.
- Fast iteration cadence — rapid release stream with visible maintainer responsiveness.
- Cross-platform coverage (macOS, Windows, Linux) ships where many competitors are macOS-only.
- Open-source (AGPL-3.0) with 14k stars and 73 contributors — real community traction.
- PR review pipeline with AI-powered template generation and bulk PR creation.

## Weaknesses

- Claude Code dependency means Aperant inherits Anthropic's pricing, rate limits, and auth friction.
- No embedded browser — significant gap for frontend/full-stack developer workflows.
- Code editor surface is review-oriented, not a deep editing environment.
- Stability regressions during fast release cycles (auth/session invalidation, freezes, update issues) are a recurring complaint.
- Team collaboration features are roadmap-only — currently single-user.
- Pricing model in transition: currently free, but paid tiers "coming soon" with no announced prices creates uncertainty.

## Pricing and Packaging

The Auto-Claude open-source project is free under AGPL-3.0. Commercial licensing available for closed-source use cases. The aperant.com website announces Pro, Team, and Enterprise tiers with "pricing coming soon" — planned features include analytics dashboards, isolated testing containers, Sentry/PostHog/Linear/Jira integrations, team workspaces, and SSO/SAML.

The core agent loop requires a Claude Pro or Max subscription (external cost to Anthropic). Optional OpenRouter usage adds separate provider costs.

## Community or Market Signal

14k GitHub stars (up from 3.6k in Feb 2026), 73 contributors, 1.9k forks. Active Discord community. The rebrand from Auto-Claude to Aperant signals commercial ambitions. Company entity is Mikalsen AI AS (Norway).

Community praise centers on parallel worktree workflow and fast iteration. Top complaints are stability regressions during fast release cycles, auth/session friction, and free-vs-paid expectation mismatch when users discover the Claude subscription requirement.

Representative positive quote:
> "After 2 days using it, I think it's near perfect... [it] got rid of branch confusion..."
— Reddit user, r/ClaudeAI

## Why It Matters to SlayZone

Aperant is the closest board-first agent orchestrator competitor. It shares SlayZone's kanban + parallel agents + worktree isolation positioning and has significant community traction (14k stars). Key differentiation for SlayZone: embedded browser per task, deeper code editor integration, multi-provider support without Claude dependency, and local-first architecture without mandatory cloud auth. Aperant's AGPL licensing and transition to paid tiers also create potential friction that SlayZone's model can exploit.

## Sources

- Source list lives in frontmatter for structure.
- Primary sources are the Aperant GitHub repository, release notes, and aperant.com website.
- Community sources include GitHub issues, Reddit threads, and the HN launch discussion.
- The third-party MCP server (ForITLLC) was verified separately from official Aperant sources.
