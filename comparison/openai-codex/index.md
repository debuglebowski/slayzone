---
name: OpenAI Codex CLI
slug: openai-codex
status: active
last_checked: 2026-03-27

primary_category: cli-agent
secondary_categories:
  - agent-sdk

platforms:
  - macos
  - linux
  - windows-experimental

workflow_shape: cli-first
deployment_model: hybrid
provider_model:
  type: multi-provider
  byok: true
  local_models: true
  # OpenAI models primary. Supports any OpenAI-compatible API endpoint.
  # --oss flag for local model providers. Works with llama.cpp, Ollama, etc.

license:
  type: open-source
  name: Apache-2.0

pricing:
  model: freemium
  summary: Free tier (limited). ChatGPT Plus $20/mo, Pro $200/mo, Business $30/user/mo. API key pay-per-token alternative.

company:
  name: OpenAI
  stage: late-stage
  funding: $168B total raised over 11 rounds, $840B valuation (incl. $120B round, Feb-Mar 2026)

links:
  website: https://openai.com/codex/
  docs: https://developers.openai.com/codex/cli
  pricing: https://developers.openai.com/codex/pricing
  github: https://github.com/openai/codex
  changelog: https://developers.openai.com/codex/changelog

relevance:
  tier: core
  rationale: Direct CLI agent competitor. SlayZone embeds Codex as a secondary agent alongside Claude Code. Understanding its feature surface shapes orchestration decisions.

tags:
  - cli-first
  - open-source
  - multi-provider
  - mcp-ecosystem
  - plugin-system
  - multi-agent

comparison_axes:
  kanban_board:
    verdict: no
    confidence: high
    note: No task board UI in the CLI. The separate cloud Codex product has a task list but no kanban. The CLI itself is purely a coding agent.
    source_ids:
      - docs-cli
      - docs-features
    last_checked: 2026-03-27

  real_terminal:
    verdict: partial
    confidence: high
    note: Runs in the terminal as a full-screen TUI. Executes shell commands with sandbox controls. Not a general-purpose PTY multiplexer — it runs commands on behalf of the agent, not the user.
    source_ids:
      - docs-cli
      - docs-features
    last_checked: 2026-03-27

  embedded_browser:
    verdict: no
    confidence: high
    note: No embedded browser pane. Has web search as a built-in tool but no browser automation or preview surface.
    source_ids:
      - docs-features
    last_checked: 2026-03-27

  code_editor:
    verdict: no
    confidence: high
    note: No built-in code editor. Proposes file changes for review. IDE extensions (VS Code, Cursor, Windsurf) leverage the host editor.
    source_ids:
      - docs-cli
      - gh-repo
    last_checked: 2026-03-27

  git_worktree_isolation:
    verdict: partial
    confidence: medium
    note: Supports working in worktrees and has sandbox isolation (workspace-write mode). But no first-class --worktree flag to create worktrees automatically — an open feature request (Issue #12862) proposes adding this. Users script it manually today.
    source_ids:
      - gh-issue-worktree
      - docs-cli
    last_checked: 2026-03-27

  mcp_client:
    verdict: yes
    confidence: high
    note: Connects to MCP servers via STDIO or Streamable HTTP. Configured in ~/.codex/config.toml or via `codex mcp` CLI commands. Launches servers automatically at session start.
    source_ids:
      - docs-mcp
    last_checked: 2026-03-27

  mcp_server:
    verdict: yes
    confidence: high
    note: "`codex mcp-server` exposes two tools (codex and codex-reply) over stdio. Any MCP client can connect. OpenAI recommends the App Server for full-fidelity integrations."
    source_ids:
      - docs-mcp
    last_checked: 2026-03-27

  multi_provider_agents:
    verdict: yes
    confidence: high
    note: Supports any OpenAI-compatible API endpoint. Custom providers configured in config.toml. --oss flag for local models (llama.cpp, Ollama). Works with DeepSeek, Qwen, Gemma, etc. True multi-provider, not just multi-host.
    source_ids:
      - docs-models
      - docs-config
    last_checked: 2026-03-27

  local_first:
    verdict: partial
    confidence: high
    note: CLI runs locally. Files stay on disk. Sessions store locally and can be resumed. But default models require API calls to OpenAI servers. Local model support exists via --oss but with reduced capability.
    source_ids:
      - docs-cli
      - docs-config
    last_checked: 2026-03-27

  native_desktop:
    verdict: partial
    confidence: high
    note: Codex App (separate product) is Electron-based, macOS and Windows. The CLI itself is terminal-native. The app wraps the CLI's app-server backend.
    source_ids:
      - codex-app-page
      - devclass-article
    last_checked: 2026-03-27

  cli_companion:
    verdict: yes
    confidence: high
    note: Codex CLI IS a CLI-first tool. Terminal is the primary interface. `codex exec` subcommand enables non-interactive scripting for CI/CD.
    source_ids:
      - docs-cli
      - docs-features
    last_checked: 2026-03-27

  issue_sync:
    verdict: partial
    confidence: medium
    note: GitHub Action (codex-action) for CI/CD integration — can apply patches and post reviews. No native issue tracker sync (Linear, Jira, etc.). MCP servers could bridge.
    source_ids:
      - gh-codex-action
    last_checked: 2026-03-27

  pr_review_workflow:
    verdict: yes
    confidence: high
    note: Built-in /review command analyzes diffs against base branches or specific commits. GitHub Action for automated PR review in CI. Cloud Codex can also review PRs.
    source_ids:
      - docs-features
      - gh-codex-action
    last_checked: 2026-03-27

  team_collaboration:
    verdict: partial
    confidence: medium
    note: Multi-agent v2 with sub-agents and structured messaging. Plugins for team-specific workflows. Business plan adds admin controls and SAML SSO. But no shared workspace or real-time collaboration surface.
    source_ids:
      - docs-features
      - pricing-page
    last_checked: 2026-03-27

  mobile_remote:
    verdict: no
    confidence: high
    note: No mobile app or remote control surface for the CLI. Cloud Codex is accessible via web but is a different product.
    source_ids:
      - docs-cli
    last_checked: 2026-03-27

  oss_posture:
    verdict: yes
    confidence: high
    note: Apache-2.0 license. CLI, SDK, App Server, Skills, and cloud environment are all open source on GitHub. 68K stars. IDE extension and web interface are proprietary.
    source_ids:
      - gh-repo
      - docs-open-source
    last_checked: 2026-03-27

assets:
  - path: assets/cli-splash.png
    caption: Codex CLI TUI showing an agentic coding session explaining a codebase with an updated plan and exploration steps.
    proves: Confirms CLI-first terminal UI, full-screen TUI interaction model, and agentic plan-and-execute workflow.
    source_url: https://github.com/openai/codex
    captured_on: 2026-03-27

sources:
  - id: docs-cli
    label: Codex CLI overview
    kind: official
    url: https://developers.openai.com/codex/cli

  - id: docs-features
    label: Codex CLI features
    kind: official
    url: https://developers.openai.com/codex/cli/features

  - id: docs-mcp
    label: MCP documentation
    kind: official
    url: https://developers.openai.com/codex/mcp

  - id: docs-models
    label: Models documentation
    kind: official
    url: https://developers.openai.com/codex/models

  - id: docs-config
    label: Advanced configuration
    kind: official
    url: https://developers.openai.com/codex/config-advanced

  - id: docs-open-source
    label: Open source components
    kind: official
    url: https://developers.openai.com/codex/open-source

  - id: pricing-page
    label: Codex pricing
    kind: official
    url: https://developers.openai.com/codex/pricing

  - id: gh-repo
    label: GitHub repository
    kind: official
    url: https://github.com/openai/codex

  - id: gh-codex-action
    label: Codex GitHub Action
    kind: official
    url: https://github.com/openai/codex-action

  - id: gh-issue-worktree
    label: Worktree flag feature request
    kind: community
    url: https://github.com/openai/codex/issues/12862

  - id: codex-app-page
    label: Codex App overview
    kind: official
    url: https://developers.openai.com/codex/app

  - id: devclass-article
    label: Codex app Mac-only criticism
    kind: third-party
    url: https://www.devclass.com/development/2026/02/05/openai-codex-app-looks-beyond-the-ide-devs-ask-why-mac-only/4090132

  - id: changelog
    label: Codex changelog
    kind: official
    url: https://developers.openai.com/codex/changelog

  - id: funding-announcement
    label: OpenAI $120B funding round (CNBC)
    kind: third-party
    url: https://www.cnbc.com/2026/03/24/openai-secures-an-extra-10-billion-in-record-funding-round-cfo-friar-says.html

  - id: hn-codex-review
    label: Codex hands-on review discussion (HN)
    kind: community
    url: https://news.ycombinator.com/item?id=44042070

  - id: zackproser-review
    label: Codex daily-use review (2026)
    kind: community
    url: https://zackproser.com/blog/openai-codex-review-2026
---

# OpenAI Codex CLI

## Summary

OpenAI's open-source CLI coding agent, built in Rust. Runs locally in the terminal, reads/edits/executes code with configurable sandbox and approval modes. 68K GitHub stars. Apache-2.0 licensed. Supports OpenAI models by default plus any OpenAI-compatible endpoint including local models. Plugin system, multi-agent sub-agents, MCP client and server. Free tier available (limited); primary access via ChatGPT Plus/Pro/Business plans.

## Positioning

Codex CLI positions itself as the open-source, terminal-native coding agent from OpenAI. Unlike Claude Code's proprietary approach, Codex leans heavily on openness: Apache-2.0 license, local model support via --oss, and a plugin ecosystem. The separate Codex App (Electron desktop) and cloud Codex (web) are companion products — the CLI is the foundational runtime.

OpenAI is building a three-surface strategy: CLI for developers, App for supervision, Cloud for async tasks. The CLI is the most relevant surface for SlayZone comparison.

## Best-Fit User or Team

Developers who:
- want an open-source CLI agent they can inspect and extend
- need multi-provider flexibility (OpenAI, local models, third-party endpoints)
- use ChatGPT Plus/Pro and want CLI agent access included in their plan
- want plugin-based extensibility and MCP integration
- prefer OpenAI models (GPT-5.4, GPT-5.3-Codex) over Anthropic

Less suited for teams needing visual task management, embedded browser previews, or a desktop-first workflow.

## Structured Feature Analysis

### Kanban / Task Board

No task management in the CLI. The separate cloud Codex product has a task list but not a kanban board. The CLI is purely a coding agent with no project management features.

### Real Terminal / PTY

Partial. Codex provides a full-screen TUI in the terminal and executes shell commands with sandbox controls (read-only, auto, full-access). But the terminal execution is agent-controlled — it runs commands for the agent, not as a general-purpose interactive PTY for the user.

### Embedded Browser

No browser integration. Web search is available as a built-in tool but there's no embedded browser pane, browser automation, or preview surface.

### Code Editor / Review Surface

No standalone editor. Codex proposes file changes for user review and approval. IDE extensions (VS Code, Cursor, Windsurf) leverage the host editor's UI. The /review command provides diff analysis but not an editing surface.

### Git Worktree Isolation

Partial. Codex can work inside git worktrees and provides sandbox isolation modes. However, there's no first-class --worktree flag to automatically create and manage worktrees (Issue #12862 is an open feature request). Users script worktree creation manually. The cloud product runs tasks in isolated sandboxes with repo clones, which is a different isolation model.

### MCP

Both client and server. As a client, connects to STDIO and Streamable HTTP MCP servers configured in config.toml or via CLI commands. As a server, `codex mcp-server` exposes tools over stdio for any MCP client. OpenAI recommends the newer App Server for full-fidelity integrations over the MCP server for complex use cases.

### Multi-Provider Agents

Yes — a key differentiator vs Claude Code. Codex supports any provider with an OpenAI-compatible API. Custom providers configured in config.toml with custom base URLs and API keys. The --oss flag enables local model providers (llama.cpp, Ollama). Works with DeepSeek, Qwen, Gemma, and others. Chat Completions API support is deprecated; Responses API is the path forward.

## Strengths

- Apache-2.0 open source — the most permissive license among major CLI agents.
- True multi-provider: OpenAI, local models, any OpenAI-compatible endpoint.
- Rust-native CLI — fast startup, low resource overhead.
- Plugin system for extensible team workflows.
- Multi-agent v2 with structured sub-agent messaging.
- MCP client and server dual posture.
- Included in ChatGPT Plus ($20/mo) — no separate subscription needed.
- Scriptable via `codex exec` for CI/CD automation.
- 68K GitHub stars, large community.

## Weaknesses

- No task management, kanban, or project management UI.
- No embedded browser or preview surface.
- No first-class worktree creation (manual scripting required).
- No mobile remote control surface.
- OpenAI models are the only high-quality option; local models are capability-reduced.
- Usage limits on ChatGPT plans can be restrictive for heavy users (33-168 messages per 5-hour window on Plus).
- Windows support is experimental (WSL recommended).
- Codex App (desktop) is a separate Electron product, not integrated into the CLI.
- No native issue tracker integrations beyond GitHub Actions.

## Pricing and Packaging

Free tier available (limited, temporary promotion). ChatGPT Plus at $20/mo includes CLI access with 33-168 messages per 5-hour window (GPT-5.4). Pro at $200/mo gives 6x limits and priority processing. Business at $30/user/mo adds admin controls and SAML SSO. API key alternative: pay-per-token with codex-mini-latest at $1.50/$6.00 per MTok in/out, or GPT-5 at $1.25/$10.00 per MTok. API users lose cloud features (GitHub review, Slack).

Credit system allows purchasing additional capacity beyond plan limits.

## Community or Market Signal

68K GitHub stars, 9.1K forks, 407 contributors, 658 releases as of March 2026. Latest stable: v0.117.0 (2026-03-26). Over 1M developers have used Codex as of February 2026.

The open-source approach generates significant community goodwill vs Claude Code's proprietary stance. HN commenters consistently highlight the Apache-2.0 license as a differentiator. Developer reviews from daily users describe Codex in 2026 as "production-ready infrastructure" and "night and day" improvement over earlier versions.

Earlier complaints about sandbox limitations (no network access, can't install dependencies) have been largely addressed with granular sandbox controls. Remaining friction points: usage limits on ChatGPT plans, complexity of the pricing/credit system, Windows support still catching up to macOS.

OpenAI's three-surface strategy (CLI + App + Cloud) is ambitious but creates confusion about which product is which.

## Why It Matters to SlayZone

Codex CLI is SlayZone's secondary embedded agent alongside Claude Code. SlayZone already orchestrates Codex sessions. The key strategic implications:

1. **Multi-provider advantage** — Codex's open provider model means SlayZone users get model diversity by embedding both Claude Code (Anthropic) and Codex (OpenAI + local).
2. **Open-source alignment** — Codex's Apache-2.0 license makes deep integration more defensible than wrapping a proprietary tool.
3. **Feature gaps SlayZone fills** — No kanban, no browser, no worktree management, no unified workspace. These are exactly what SlayZone provides on top.
4. **Plugin competition** — Codex's plugin system could reduce the need for an orchestration layer if it grows into task/project management territory.

## Sources

Source list lives in frontmatter. Key sources:
- [Codex CLI docs](https://developers.openai.com/codex/cli) — primary product docs
- [GitHub repo](https://github.com/openai/codex) — 68K stars, Apache-2.0
- [Pricing](https://developers.openai.com/codex/pricing) — plan details and credit system
- [MCP docs](https://developers.openai.com/codex/mcp) — client and server integration
- [Open source components](https://developers.openai.com/codex/open-source) — what's open vs proprietary
