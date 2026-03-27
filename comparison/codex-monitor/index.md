---
name: Codex Monitor
slug: codex-monitor
status: active
last_checked: 2026-03-27

primary_category: agent-orchestrator
secondary_categories:
  - codex-wrapper

platforms:
  - macos
  - windows
  - linux

workflow_shape: workspace-first
deployment_model: local

provider_model:
  type: single-provider
  byok: true
  local_models: false

license:
  type: open-source
  name: MIT

pricing:
  model: free
  summary: Free and open source. No paid tier.

company:
  name: Thomas Ricouard (solo developer)
  stage: indie
  funding: self-funded

links:
  website: https://www.codexmonitor.app/
  github: https://github.com/Dimillian/CodexMonitor
  changelog: https://www.codexmonitor.app/changelog.html

relevance:
  tier: core
  rationale: Direct competitor in the Codex orchestration space. Closest third-party desktop app for multi-agent Codex management — overlaps with SlayZone's workspace, worktree, and agent orchestration positioning.

tags:
  - desktop-first
  - multi-agent
  - worktree-aware
  - watch-closely

comparison_axes:
  kanban_board:
    verdict: no
    confidence: high
    note: No kanban or task board UI. Threads and workspaces are organized in a sidebar/dashboard, not a board layout.
    source_ids:
      - website
      - github
    last_checked: 2026-03-27

  real_terminal:
    verdict: yes
    confidence: high
    note: Integrated terminal dock with multiple command tabs.
    source_ids:
      - website
      - github
    last_checked: 2026-03-27

  embedded_browser:
    verdict: no
    confidence: high
    note: No embedded browser pane.
    source_ids:
      - website
      - github
    last_checked: 2026-03-27

  code_editor:
    verdict: no
    confidence: high
    note: Explicitly positions itself as "the next-generation IDE without a text editor built in, because you don't need it." Has diff viewing but no editing surface.
    source_ids:
      - website
    last_checked: 2026-03-27

  git_worktree_isolation:
    verdict: yes
    confidence: high
    note: First-class worktree support — per-branch isolated worktrees for clean reviews. Worktrees live under the app data directory.
    source_ids:
      - website
      - github
    last_checked: 2026-03-27

  mcp_client:
    verdict: no
    confidence: high
    note: No evidence of MCP client support. Relies on Codex app-server protocol, not MCP.
    source_ids:
      - github
    last_checked: 2026-03-27

  mcp_server:
    verdict: no
    confidence: high
    note: No MCP server exposed.
    source_ids:
      - github
    last_checked: 2026-03-27

  multi_provider_agents:
    verdict: no
    confidence: high
    note: Codex-only. Wraps the OpenAI Codex app-server exclusively. No support for Claude, Gemini, or other agent backends.
    source_ids:
      - website
      - github
    last_checked: 2026-03-27

  local_first:
    verdict: yes
    confidence: high
    note: Fully local — Tauri desktop app with JSON file persistence. No cloud account or telemetry requirement. Codex API calls go through OpenAI but the app itself is local-first.
    source_ids:
      - github
    last_checked: 2026-03-27

  native_desktop:
    verdict: yes
    confidence: high
    note: Tauri app shipping on macOS, Windows, and Linux.
    source_ids:
      - website
      - github
    last_checked: 2026-03-27

  cli_companion:
    verdict: no
    confidence: high
    note: Desktop-only. Has an optional remote daemon but no standalone CLI.
    source_ids:
      - github
    last_checked: 2026-03-27

  issue_sync:
    verdict: partial
    confidence: medium
    note: GitHub Issues browsing via gh CLI integration. Read-only access, not structured two-way sync.
    source_ids:
      - website
      - github
    last_checked: 2026-03-27

  pr_review_workflow:
    verdict: partial
    confidence: medium
    note: Built-in diff viewing and "Ask PR" feature to incorporate PR context into threads. No PR creation flow documented.
    source_ids:
      - website
      - github
    last_checked: 2026-03-27

  team_collaboration:
    verdict: no
    confidence: high
    note: Single-user desktop app. No team features, shared workspaces, or collaboration layer.
    source_ids:
      - website
      - github
    last_checked: 2026-03-27

  mobile_remote:
    verdict: partial
    confidence: medium
    note: iOS build exists with remote backend support via Tailscale, but marked as experimental. Terminal and dictation unavailable on iOS.
    source_ids:
      - github
    last_checked: 2026-03-27

  oss_posture:
    verdict: yes
    confidence: high
    note: MIT licensed. Fully open source on GitHub with ~3.4k stars (as of March 2026).
    source_ids:
      - github
    last_checked: 2026-03-27

assets:
  - path: assets/dashboard-overview.png
    caption: Main dashboard and chat view showing workspace orchestration.
    proves: Confirms command-center layout with sidebar workspaces, thread view, and integrated panels.
    source_url: https://www.codexmonitor.app/
    captured_on: 2026-03-27
  - path: assets/projects-hub.png
    caption: Projects hub showing workspace and thread overview.
    proves: Confirms multi-workspace management and thread tracking UI.
    source_url: https://www.codexmonitor.app/
    captured_on: 2026-03-27

sources:
  - id: website
    label: Official marketing site
    kind: official
    url: https://www.codexmonitor.app/

  - id: github
    label: GitHub repository and README
    kind: official
    url: https://github.com/Dimillian/CodexMonitor

  - id: theo-testimonial
    label: Theo (t3.gg) testimonial on X
    kind: community
    url: https://x.com/theo/status/2017123772697117041
---

# Codex Monitor

## Summary

Codex Monitor is a Tauri-based desktop app by Thomas Ricouard (Dimillian) that orchestrates multiple OpenAI Codex agents across local workspaces. It wraps the Codex app-server protocol into a polished command-center UI with workspace management, thread control, worktree isolation, and Git integration. Free, MIT-licensed, ~3.4k GitHub stars as of March 2026.

## Positioning

A "desktop command center for Codex" — explicitly not an IDE. Positions itself as the orchestration layer between the developer and multiple Codex agent sessions. The tagline "from repo to review in three moves" signals a workflow-compression pitch. Explicitly disclaims being affiliated with OpenAI.

The product leans into the "next-generation IDE without a text editor" framing — arguing that agent-driven workflows don't need a code editor, just a conversation surface, diff viewer, and terminal.

## Best-Fit User or Team

Solo developers or small teams running multiple Codex agents across several repositories. Users who want a dedicated GUI for Codex rather than switching between terminal tabs. Strongest fit for developers already committed to the OpenAI Codex ecosystem who want better workspace organization.

## Structured Feature Analysis

### Kanban / Task Board

No board UI. Work is organized around workspaces and threads in a sidebar layout, not a kanban-style task board. There is no concept of task status columns, drag-and-drop prioritization, or project-level task management.

### Real Terminal / PTY

Integrated terminal dock with support for multiple command tabs. Terminal is available alongside the conversation and diff views in the main layout.

### Embedded Browser

No embedded browser. The product focuses on code and agent conversation, not web preview.

### Code Editor / Review Surface

Explicitly rejects the code editor pattern — "the next-generation IDE without a text editor built in, because you don't need it." Has syntax-highlighted diff viewing and file tree browsing, but no editing surface. Code changes flow through the Codex agent, not through manual editing.

### Git Worktree Isolation

First-class feature. Supports per-branch worktrees for isolated agent work and clean reviews. Worktrees are created under the app data directory. Also supports clone-based agents as an alternative isolation strategy.

### MCP

No MCP support in either direction. The app communicates with Codex through the stdio-based app-server protocol, which is proprietary to the Codex ecosystem. This locks the product into OpenAI's tooling chain.

### Multi-Provider Agents

Codex-only. The entire product is built around the Codex app-server protocol. No support for Claude Code, Gemini, or other agent backends. Model selection exists but only within OpenAI's model lineup.

## Strengths

- Polished, purpose-built desktop UI for Codex orchestration with strong visual design.
- First-class worktree isolation — one of the few orchestrators that treats worktrees as a core primitive.
- Fully open source (MIT) with active solo development and rapid iteration (v0.7.63 as of late March 2026).
- Good Git and GitHub integration — diffs, logs, branch controls, and Issues browsing built in.
- Testimonials from notable developers (Theo/t3.gg) indicate real community traction.
- Remote daemon mode enables running agents on a separate machine, with experimental iOS support.

## Weaknesses

- Locked to OpenAI Codex — no multi-provider support means users can't use Claude Code or other agents.
- No task management or kanban board — purely a conversation and workspace orchestrator, not a project management surface.
- No code editor — forces all changes through the agent, which may frustrate users who want direct editing.
- Solo developer project — sustainability risk if maintainer moves on.
- No team collaboration features — single-user only.
- No MCP support limits extensibility compared to tools in the MCP ecosystem.

## Pricing and Packaging

Completely free. MIT-licensed open source. No paid tier, no SaaS component, no telemetry. Users need their own OpenAI API access for the underlying Codex agent.

## Community or Market Signal

~3.4k GitHub stars indicates solid traction for an indie open-source tool. Rapid release cadence (v0.7.63 in March 2026) shows active development. Theo (t3.gg) publicly endorsed it as "the best performing tool like this" — strong signal from a high-reach developer influencer. Multiple community testimonials praise the workflow consolidation ("from multiple VS Code windows to just one app").

The project is in beta and the website includes a disclaimer about no warranties during the beta period.

## Why It Matters to SlayZone

Codex Monitor is the closest direct competitor in the "desktop orchestration wrapper for coding agents" space. Key comparison angles:

1. **Agent lock-in vs. multi-provider**: Codex Monitor is Codex-only; SlayZone supports Claude Code and Codex. This is SlayZone's strongest differentiator.
2. **Task management**: Codex Monitor has no kanban or task board. SlayZone's integrated task management is a clear capability gap.
3. **Worktree parity**: Both products treat worktree isolation as important. Codex Monitor's implementation is mature and well-integrated.
4. **Editor philosophy**: Codex Monitor explicitly rejects the code editor; SlayZone includes one. Different bets on whether developers want direct editing alongside agent work.
5. **Community momentum**: With ~3.4k stars and Theo's endorsement, Codex Monitor has real visibility in the Codex ecosystem. It sets user expectations for what a Codex wrapper should look like.

## Sources

- Source list lives in frontmatter for structure.
- The official website and GitHub README are the primary sources. The product is new enough that third-party coverage is limited to social media testimonials.
