---
name: Polyscope
slug: polyscope
status: active
last_checked: 2026-03-27

primary_category: agent-orchestrator
secondary_categories:
  - desktop-environment

platforms:
  - macos
  # macOS 13.3+ required. No Windows or Linux.

workflow_shape: workspace-first
deployment_model: local
provider_model:
  type: multi-provider
  byok: true
  local_models: false

license:
  type: proprietary
  name: Proprietary

pricing:
  model: freemium
  summary: Free tier (unlimited projects/agents). Pro $8/mo (annual). Team $25/mo (annual, 10 seats).

company:
  name: Beyond Code
  stage: established-indie
  funding: bootstrapped
  founded: 2017
  location: "Mönchengladbach, Germany"
  employees: ~5

links:
  website: https://getpolyscope.com
  docs: https://getpolyscope.com/docs
  community: https://github.com/beyondcode/polyscope-community

relevance:
  tier: core
  rationale: Direct overlap with SlayZone's parallel-agent orchestration and desktop workspace positioning. Same agent families (Claude Code, Codex). Differentiated by COW clones vs worktrees, built-in browser, and mobile relay.

tags:
  - desktop-first
  - multi-agent
  - laravel-ecosystem
  - watch-closely
  - cow-clones

comparison_axes:
  kanban_board:
    verdict: partial
    confidence: medium
    note: Autopilot mode decomposes goals into user stories with drag-and-drop reordering and progress tracking. Story-list orientation, not a full kanban board with lane-based card movement.
    source_ids:
      - everydev-profile
      - laravel-news-launch
    last_checked: 2026-03-27

  real_terminal:
    verdict: yes
    confidence: high
    note: Real PTY terminal panel (distinct from agent activity feed). Confirmed by interactive shell sessions (exit command closes session), focus stealing between terminal and chat panes, Nerd Font glyph rendering, customizable fonts (v0.7). Bash mode (! prefix) for inline shell execution from chat. Built on Tauri + Astro web frontend, likely xterm.js. Terminal also accessible via E2E encrypted remote relay.
    source_ids:
      - docs-quickstart
      - twitter-v0.7
      - gh-issue-14
      - gh-issue-27
      - gh-issue-13
    last_checked: 2026-03-27

  embedded_browser:
    verdict: yes
    confidence: high
    note: Built-in preview browser for visual prompting. v0.12.0 added dynamic preview URLs via polyscope.json. In-browser element annotations announced for visual-to-prompt workflows.
    source_ids:
      - twitter-launch
      - twitter-v0.12
    last_checked: 2026-03-27

  code_editor:
    verdict: partial
    confidence: medium
    note: Diff panel with syntax highlighting and inline commenting (Cmd+D). Review-oriented code surface. Not a full editing environment; positioned as orchestration cockpit.
    source_ids:
      - docs-quickstart
    last_checked: 2026-03-27

  git_worktree_isolation:
    verdict: no
    confidence: high
    note: Uses APFS copy-on-write filesystem clones, not git worktrees. Each workspace gets a COW clone + fresh branch. Near-instant, zero extra disk space until files are modified.
    source_ids:
      - docs-quickstart
      - twitter-cow-claim
    last_checked: 2026-03-27

  mcp_client:
    verdict: unknown
    confidence: low
    note: No documentation or announcements mention MCP client support. Underlying agents (Claude Code, Codex) have their own MCP support, but Polyscope does not appear to add an MCP client layer.
    source_ids:
      - docs-quickstart
    last_checked: 2026-03-27

  mcp_server:
    verdict: no
    confidence: medium
    note: No evidence of MCP server exposure in docs or community.
    source_ids:
      - docs-quickstart
    last_checked: 2026-03-27

  multi_provider_agents:
    verdict: yes
    confidence: high
    note: Claude Code, OpenAI Codex, and Cursor CLI (v0.13). Three distinct agent families. Opus 1M context and fast mode supported (v0.12.0). BYOK via underlying CLI tools.
    source_ids:
      - docs-quickstart
      - twitter-v0.13
      - twitter-v0.12
    last_checked: 2026-03-27

  local_first:
    verdict: yes
    confidence: high
    note: macOS native app, SQLite DB at ~/.polyscope/, repository clones stored locally. BYOK model keys. Remote relay is opt-in, E2E encrypted.
    source_ids:
      - docs-quickstart
    last_checked: 2026-03-27

  native_desktop:
    verdict: yes
    confidence: high
    note: macOS-only native desktop app. Requires macOS 13.3+.
    source_ids:
      - docs-quickstart
    last_checked: 2026-03-27

  cli_companion:
    verdict: partial
    confidence: medium
    note: Laravel/PHP SDK enables remote control (start workspaces from prompts or PRs). Not a standalone CLI but provides programmatic access.
    source_ids:
      - twitter-laravel-sdk
    last_checked: 2026-03-27

  issue_sync:
    verdict: partial
    confidence: medium
    note: GitHub integration via gh CLI for PR creation and issue management. Not full structured two-way issue sync.
    source_ids:
      - docs-quickstart
    last_checked: 2026-03-27

  pr_review_workflow:
    verdict: yes
    confidence: high
    note: Diff panel with syntax highlighting, inline commenting, PR creation via gh CLI, and merge-to-base-branch option. Core output workflow.
    source_ids:
      - docs-quickstart
    last_checked: 2026-03-27

  team_collaboration:
    verdict: partial
    confidence: medium
    note: Team plan with 10 seats and centralized billing. Remote relay enables shared access. Not deeply collaborative (no shared workspace state or real-time co-editing).
    source_ids:
      - everydev-profile
    last_checked: 2026-03-27

  mobile_remote:
    verdict: yes
    confidence: high
    note: E2E encrypted relay accessible from any browser including mobile. QR code pairing, no Tailscale needed. Includes terminal access. Pro feature.
    source_ids:
      - twitter-mobile-relay
    last_checked: 2026-03-27

  oss_posture:
    verdict: no
    confidence: high
    note: Closed source. Community GitHub repo (12 stars, 44 issues) is issue tracker and discussions only, not source code.
    source_ids:
      - github-community
    last_checked: 2026-03-27

assets:
  - path: assets/product-card.png
    caption: Marketing card from getpolyscope.com showing app sidebar with project tree, workspace branches, and diff stats.
    proves: Confirms workspace-centric sidebar layout, multi-repo support, branch/diff view.
    source_url: https://getpolyscope.com/images/card.png
    captured_on: 2026-03-27

  - path: assets/mobile-ui.png
    caption: Mobile web interface via E2E encrypted relay showing repository list and workspace branches on iPhone Safari.
    proves: Confirms mobile remote access, repository/workspace browsing from phone.
    source_url: https://getpolyscope.com/images/landing/features/autopilot.png
    captured_on: 2026-03-27

sources:
  - id: website
    label: Polyscope homepage
    kind: official
    url: https://getpolyscope.com

  - id: docs-quickstart
    label: Getting started / quickstart docs
    kind: official
    url: https://getpolyscope.com/docs/getting-started/quickstart

  - id: github-community
    label: Community issue tracker
    kind: official
    url: https://github.com/beyondcode/polyscope-community

  - id: twitter-launch
    label: Marcel Pociot launch announcement
    kind: official
    url: https://x.com/marcelpociot/status/2028891802191761427

  - id: twitter-mobile-relay
    label: Marcel Pociot on mobile relay / remote access
    kind: official
    url: https://x.com/marcelpociot/status/2028979185629151577

  - id: twitter-v0.7
    label: v0.7 - Terminal font, file @-mentions
    kind: official
    url: https://x.com/marcelpociot/status/2029691056569118972

  - id: twitter-v0.12
    label: v0.12.0 - Opus 1M, fast mode, dynamic preview URLs
    kind: official
    url: https://x.com/marcelpociot/status/2034388479354773666

  - id: twitter-v0.13
    label: v0.13 - Cursor CLI support
    kind: official
    url: https://x.com/marcelpociot/status/2036086782966546546

  - id: twitter-laravel-sdk
    label: Laravel/PHP SDK for remote control
    kind: official
    url: https://x.com/marcelpociot/status/2033209769599607100

  - id: twitter-cow-claim
    label: Marcel Pociot on COW clone uniqueness
    kind: official
    url: https://x.com/marcelpociot/status/2035269860079341869

  - id: gh-issue-14
    label: "Community issue #14 - Terminal exit behavior"
    kind: community
    url: https://github.com/beyondcode/polyscope-community/issues/14

  - id: gh-issue-27
    label: "Community issue #27 - Terminal focus stealing from chat"
    kind: community
    url: https://github.com/beyondcode/polyscope-community/issues/27

  - id: gh-issue-13
    label: "Community issue #13 - Nerd Font rendering in terminal"
    kind: community
    url: https://github.com/beyondcode/polyscope-community/issues/13

  - id: laravel-news-launch
    label: Laravel News launch article
    kind: press
    url: https://laravel-news.com/polyscope-is-an-ai-first-dev-environment-for-orchestrating-agents

  - id: everydev-profile
    label: EveryDev.ai tool profile
    kind: press
    url: https://www.everydev.ai/tools/polyscope
---

# Polyscope

## Summary

Polyscope is a macOS-native desktop app for orchestrating multiple AI coding agents in parallel, built by Beyond Code (Marcel Pociot). Launched March 2026. Its differentiator is APFS copy-on-write workspace clones -- near-instant, zero-disk-overhead isolation without git worktrees. Supports Claude Code, Codex, and Cursor CLI. Freemium model with a strong built-in browser and mobile remote access via E2E encrypted relay.

## Positioning

Polyscope positions itself as "the new cockpit" for AI-first development. The core thesis: developers should run many agents simultaneously, each in an isolated clone, and orchestrate results through a desktop hub. It comes from the Laravel/PHP ecosystem (Beyond Code has been building dev tools since 2017) but targets all developers. The product leans on three pillars: parallel agent execution, visual prompting via embedded browser, and mobile-accessible remote relay.

## Best-Fit User or Team

Solo developers or small teams who want to run multiple Claude Code/Codex/Cursor agents simultaneously on their Mac. Particularly strong for developers already in the Beyond Code / Laravel ecosystem. Best for users who value built-in browser preview and mobile access. Less suited for users who need cross-platform support, git worktree semantics, or full kanban-style task management.

## Structured Feature Analysis

### Kanban / Task Board

Autopilot mode accepts a high-level goal and decomposes it into user stories, each executed by an agent with progress tracking, crash recovery, and drag-and-drop reordering. This is closer to a linear story queue than a kanban board -- there are no visible status lanes or card-based board semantics in public materials. Verdict: partial.

### Real Terminal / PTY

Polyscope has two distinct terminal surfaces: a real PTY-based terminal panel and the agent activity feed (which shows agent output in a chat-like view). The terminal panel is confirmed by community reports of interactive shell sessions (exit command closes the session), focus stealing between terminal and chat panes during concurrent use, and Nerd Font glyph rendering. Built on Tauri + Astro (web frontend), likely xterm.js. Customizable fonts added in v0.7. A "bash mode" (`!command` prefix) also exists for inline shell execution from the chat input. Terminal accessible via E2E encrypted remote relay. Verdict: yes.

### Embedded Browser

Built-in preview browser is a first-class feature. Users can visually prompt agents by interacting with the browser preview. v0.12.0 added dynamic preview URLs via `polyscope.json` configuration. In-browser element annotations (select an element, generate a prompt) are in progress. This is stronger than most competitors in the category. Verdict: yes.

### Code Editor / Review Surface

Diff panel with syntax highlighting and inline commenting (Cmd+D). File @-mentions in diff comments (v0.7). The code surface is review-oriented -- designed for inspecting agent output, not for extended manual editing. No documented full file editor mode. Verdict: partial.

### Git Worktree Isolation

Polyscope explicitly does not use git worktrees. Instead, it creates APFS copy-on-write filesystem clones of the repository, then checks out a fresh branch in each clone. This gives isolation properties similar to worktrees (each workspace has its own working tree and branch) but at the filesystem level rather than the git level. Marcel Pociot claims Polyscope is "the only tool using blazing fast Copy on Write clones." Trade-off: COW clones are faster to create and simpler to reason about, but lose git worktree metadata linkage. Verdict: no (uses COW clones, not worktrees).

### MCP

No documented MCP client or server support at the Polyscope application level. The underlying agents (Claude Code, Codex) carry their own MCP support, but Polyscope doesn't add an orchestration-level MCP layer. Verdict: client unknown, server no.

### Multi-Provider Agents

Three agent families: Claude Code, OpenAI Codex, and Cursor CLI (v0.13, March 2026). v0.12.0 added Opus 1M context models, reasoning effort selection, and fast mode. Kimi 2.5 listed as coming soon. BYOK via the underlying CLI tools. Breadth is meaningful and growing. Verdict: yes.

## Strengths

- APFS copy-on-write clones are genuinely fast and novel in this category. Near-instant workspace creation with zero extra disk cost.
- Built-in preview browser is best-in-class for the agent orchestrator segment. Visual prompting is a real differentiator.
- Mobile/remote relay with E2E encryption and QR pairing. No VPN needed. Unique in the category.
- Established company (Beyond Code, since 2017) with Laravel ecosystem credibility and existing customer base.
- Freemium model with meaningful free tier (unlimited projects and agents).
- High release velocity -- v0.7 through v0.13 in under a month.
- Laravel/PHP SDK for programmatic remote control.

## Weaknesses

- macOS only. No Windows, no Linux.
- Closed source. Community repo is issue tracker only.
- No git worktree semantics -- COW clones lose branch metadata linkage that worktree-based tools preserve.
- No MCP support at the orchestration level.
- No full code editor -- review surface only.
- Autopilot story decomposition is not a replacement for structured kanban/PM tooling.
- Limited documentation. Docs are sparse; many feature details only available via Twitter announcements.
- Small team (~5) for an ambitious product category.

## Pricing and Packaging

| Plan | Price | Key features |
|------|-------|-------------|
| Free | $0 | Unlimited projects, parallel agents, GitHub integration, multi-model support |
| Pro | $8/mo (annual) | Opinions, visual editing, E2E mobile access, email support |
| Team | $25/mo (annual) | 10 seats, centralized billing, priority support |

The free tier is generous -- core parallel agent orchestration is not gated. Pro unlocks visual/browser features and remote access. Team adds seat management. No per-agent or per-token pricing from Polyscope itself; users pay their own API costs.

## Community or Market Signal

Polyscope launched March 3, 2026 and gained immediate attention in the Laravel/PHP community. Coverage in Laravel News and Beyond Code's existing audience. Community repo has 44 open issues and 12 stars after 3 weeks, suggesting active but early adoption.

Marcel Pociot's personal brand (active Twitter presence, Laravel ecosystem credibility) drives visibility. The "only tool using COW clones" claim is a notable marketing differentiator.

No significant community complaints documented yet -- the product is too new. The main risk is category crowding: Conductor, VibeKanban, Maestro, and others are all competing in the same space.

## Why It Matters to SlayZone

Polyscope is a direct competitor with significant overlap: macOS desktop, parallel agents, Claude Code + Codex support, workspace isolation, built-in browser. Key differentiation for SlayZone:

1. **Worktrees vs COW clones**: SlayZone uses git worktrees (branch metadata linkage). Polyscope uses filesystem COW clones (faster creation, but no worktree semantics).
2. **Task-centric vs workspace-centric**: SlayZone organizes around tasks with per-task terminal/browser/editor bundles. Polyscope organizes around workspaces with autopilot story queues.
3. **MCP**: SlayZone exposes an MCP server. Polyscope has no MCP layer.
4. **Browser**: Polyscope's embedded browser with visual prompting is stronger than most competitors. SlayZone should watch their annotation feature closely.
5. **Mobile relay**: Polyscope's E2E encrypted remote access is unique in the category.
6. **OSS posture**: SlayZone is open. Polyscope is closed.

Watch closely: browser annotation feature, Kimi 2.5 integration, and whether COW clones prove more appealing than worktrees to the market.

## Sources

Source list lives in frontmatter. Key sources for this record:
- Official docs (quickstart) for architecture and workflow facts.
- Marcel Pociot's Twitter for feature announcements (v0.7 through v0.13), launch details, and COW clone positioning.
- Laravel News and EveryDev.ai for third-party product profiles with pricing and feature coverage.
- Community GitHub repo for adoption signals (issue count, stars).
