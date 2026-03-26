# Conductor

> Last evaluated: 2026-02-28
> Website: https://www.conductor.build/
> GitHub: N/A (closed source)
> Stars: N/A
> License: Proprietary

## Summary
Conductor is a macOS-only desktop app focused on running multiple coding agents (primarily Claude Code and Codex) across isolated workspaces/worktrees. It has moved fast in 2025, adding task/status management, richer terminal tooling, MCP client support, and broader provider configuration, but it still does not expose an MCP server and remains less per-task-isolated than SlayZone.

## Datapoint Evaluation

| Feature | Verdict | Notes |
|---------|---------|-------|
| Kanban board | ~ | Added tasks and status lanes (Backlog/In Progress/In Review/Done), but no clear drag-first Kanban board UX documented. |
| Local-first | ~ | Chats and messages stay local; account/analytics still cloud-backed. |
| MCP server | ~ | Strong MCP client support (local/remote servers) but no evidence of Conductor exposing its own MCP server. |
| Keyboard-driven | ~ | Large shortcut surface and cheat sheet, but still mixed mouse+keyboard and no documented Vim mode parity. |
| Terminal | ~ | Real command execution with terminal tabs and script runner, but not structured as per-task terminal isolation like SlayZone. |
| Embedded browser | ~ | Claude Code for Chrome integration exists, but no clear per-task embedded browser pane equivalent to SlayZone’s model. |
| Code editor | ~ | Diff/review flow is strong; editing model appears review-centric rather than a full primary IDE replacement. |
| Git worktree isolation | ✓ | Workspaces are branch/worktree-centric, including PR/merge lifecycle and multi-agent workflows. |
| Multi-provider AI agents | ~ | Multi-provider support exists via Claude/Codex paths and provider env config, but breadth is narrower than SlayZone’s agent matrix. |

---

## Detailed Feature Analysis

### Kanban / Task Management
Conductor originally looked like a multi-workspace agent launcher with no formal task board, which is why many older comparisons tagged it as "no Kanban." That changed in late 2025: `v0.33.0` explicitly introduced "tasks" and `v0.35.0` introduced workspace status organization across `Backlog`, `In Progress`, `In Review`, and `Done` views ([v0.33.0](https://changelog.conductor.build/2025-10-24-conductor-v0.33.0), [v0.35.0](https://changelog.conductor.build/2025-11-17-conductor-v0.35.0)).

Functionally, this is task-management and workflow-state support, but official docs/changelog material does not clearly describe a drag-and-drop Kanban board with card movement semantics comparable to dedicated PM boards. The product appears to have status lanes and task objects rather than a documented visual board-first workflow. Relative to SlayZone’s explicit board model, this is best scored as partial support.

Community sentiment is aligned with that nuance: users on Reddit discuss Conductor primarily as a parallel-agent launcher and workspace organizer rather than a PM board replacement, with more focus on running multiple sessions than managing rich task metadata ([Reddit thread](https://www.reddit.com/r/ClaudeAI/comments/1n3ejhr/conductor_the_first_multiclaude_app/)).

### Local-First Architecture
Conductor’s privacy docs are explicit that chat history and messages are stored locally on the user’s machine and not stored on Conductor servers. They also state network traffic for model calls goes directly to model providers (Anthropic/OpenAI/etc.) rather than proxying model payloads through Conductor infrastructure ([Privacy](https://docs.conductor.build/account/privacy)).

At the same time, Conductor is not pure local-only: account data is stored in encrypted Postgres (Fly.io), and product analytics/feature usage is tracked via PostHog per their privacy docs. That creates a hybrid model: local chat data plus cloud account/telemetry services. Workspace state is also file-system grounded (`~/conductor/workspaces` setting introduced in `v0.25.0`) ([v0.25.0](https://changelog.conductor.build/2025-08-13-conductor-v0.25.0)).

Compared with SlayZone’s strict local-first posture, Conductor should be considered partially local-first. It has substantial local persistence and local execution properties, but not "all data local, no cloud footprint."

### MCP Support
Conductor now has meaningful MCP integration depth on the client side. Official MCP docs cover setup, local/remote transports, server management via Claude Code config, and health/status handling in the UI ([MCP docs](https://docs.conductor.build/core/mcp)). Changelog updates also show steady operational hardening, including a dedicated MCP status display (`v0.25.0`) and reconnection improvements (`v0.34.0`) ([v0.25.0](https://changelog.conductor.build/2025-08-13-conductor-v0.25.0), [v0.34.0](https://changelog.conductor.build/2025-11-11-conductor-v0.34.0)).

However, there is no documentation that Conductor itself exposes an MCP server endpoint/tool surface for other agents or external clients to consume. In practice, Conductor appears to be an MCP-capable host/client around Claude Code sessions, not an MCP server product. That is why this scores partial rather than full for a row specifically labeled "MCP server."

SlayZone’s differentiation here remains clear if the comparison criterion is "does the product expose its own MCP server for external tool access?" Conductor’s strength is in consuming MCP ecosystems, not publishing one.

### Keyboard-Driven
Conductor has significantly expanded keyboard workflows throughout 2025. Documented shortcuts include creation and review actions (`Cmd+Shift+N`, `Cmd+D`, `Cmd+Shift+P`), PR/review operations (`Cmd+Shift+R`, `Cmd+Shift+X`, `Cmd+Shift+G`, `Cmd+Shift+L`, `Cmd+Shift+M`), workspace navigation (`Cmd+1-9`, `Cmd+Shift+A`), terminal controls (`Cmd+R`, `Cmd+Shift+1-5`, `Cmd+W`, `Cmd+T`), search/result traversal (`Cmd+G`, `Cmd+Shift+G`), and path/file workflow actions (`Cmd+O`, `Cmd+Shift+C`) ([v0.31.1](https://changelog.conductor.build/2025-09-16-conductor-v0.31.1), [v0.31.2](https://changelog.conductor.build/2025-09-17-conductor-v0.31.2), [v0.30.0](https://changelog.conductor.build/2025-09-12-conductor-v0.30.0), [v0.8.0](https://changelog.conductor.build/2025-06-24-conductor-v0.8.0), [v0.5.0](https://changelog.conductor.build/2025-06-18-conductor-v0.5.0)).

`v0.29.4` added an in-app shortcut cheatsheet (`Cmd+/`), which is the best source of truth for current bindings in product builds ([v0.29.4](https://changelog.conductor.build/2025-09-08-conductor-v0.29.4)). Keyboard robustness is still evolving; changelog notes show fixes for shortcut conflicts and regressions (for example `Cmd+Z` and terminal key handling in `v0.31.0`) ([v0.31.0](https://changelog.conductor.build/2025-09-15-conductor-v0.31.0)).

No official docs confirm full Vim keybinding compatibility across the app. There are isolated Vim-like affordances (for example `j/k` navigation in chat noted in changelog), but not a documented "Vim mode" equivalent to full editor/navigation parity. Net: strong shortcut support, but not conclusively keyboard-only or Vim-complete.

### Terminal
Conductor executes shell commands with the same permissions as the logged-in user, and explicitly states there is no Conductor sandbox layer. That means command execution is real host execution, not a simulated output panel ([FAQ](https://docs.conductor.build/account/faq)).

Terminal capabilities have expanded materially: "Big Terminal Mode" (`v0.8.0`), run tab + script runner docs, and terminal tab management shortcuts (`v0.30.0`) indicate a genuine operator workflow for command-heavy work ([v0.8.0](https://changelog.conductor.build/2025-06-24-conductor-v0.8.0), [Scripts docs](https://docs.conductor.build/core/scripts), [v0.30.0](https://changelog.conductor.build/2025-09-12-conductor-v0.30.0)).

The limitation versus SlayZone is isolation granularity: Conductor is workspace/agent centric, not "every task card has its own PTY + browser + editor bundle." So terminal support is real, but not per-task isolated in the same way.

### Embedded Browser
Conductor introduced "Claude Code for Chrome" in `v0.30.0`, enabling agents to browse websites, take screenshots, inspect console logs, and run browser actions during workflows ([v0.30.0](https://changelog.conductor.build/2025-09-12-conductor-v0.30.0)).

That is meaningful browser capability, but available evidence points to integration with Chrome tooling rather than a dedicated always-present in-app embedded browser pane per workspace/task. This differs from SlayZone’s explicit "built-in Chromium per task" positioning in the comparison matrix.

Result: partial support. Conductor can do browser-assisted agent operations, but documentation does not establish a first-class embedded browser surface with the same per-task UX contract.

### Code Editor
Conductor’s strongest code-surface feature is review ergonomics: docs and changelog emphasize a dedicated diff viewer and review pipeline (`Cmd+D`, review/fix/merge actions), plus "checks" support and improved visibility for command outcomes ([Diff Viewer docs](https://docs.conductor.build/core/diff-viewer), [v0.31.1](https://changelog.conductor.build/2025-09-16-conductor-v0.31.1)).

There is also a clear "open in IDE" path (`Cmd+O`) for Cursor and other external editors, suggesting Conductor is intentionally positioned as an orchestration/review cockpit rather than the sole source editor for deep coding sessions ([Open in IDE docs](https://docs.conductor.build/core/open-in-ide)).

Compared to SlayZone’s integrated task-local coding model, Conductor’s editor story is capable but review-centric. It is strong for agent output inspection and merge decisions, less clearly a full-featured in-app editing environment.

### Git Worktree Isolation
This is one of Conductor’s strongest areas. Official docs state each workspace corresponds to a git branch/worktree flow, and PR creation/merge is built into core workflow (`Cmd+Shift+P`, merge actions). Users can run many workspaces in parallel and the app supports handling multiple repositories (`/add-dir`) and branch/worktree lifecycle operations ([First workspace](https://docs.conductor.build/get-started/first-workspace), [Workspaces and Branches](https://docs.conductor.build/core/workspaces-and-branches), [v0.31.1](https://changelog.conductor.build/2025-09-16-conductor-v0.31.1)).

Storage/location behavior is also documented, including configurable workspace paths and migration away from older `.conductor` locations (`v0.25.0`). That level of lifecycle control and explicit branch isolation is directly competitive with SlayZone’s worktree isolation value proposition ([v0.25.0](https://changelog.conductor.build/2025-08-13-conductor-v0.25.0)).

Known caveats remain around operational scale and edge cases (for example changelog/FAQ items around repo states, reconnection, and auth friction), but feature completeness for worktree-based isolation is high.

### Multi-Provider AI Agents
Conductor’s homepage and docs emphasize support for both Claude Code and Codex ([Homepage](https://www.conductor.build/), [Welcome docs](https://docs.conductor.build/introduction/welcome)). Changelog entries show active model cadence across both stacks, including Opus/Sonnet releases and GPT-5 family additions (`v0.5.0`, `v0.31.x`, `v0.34.0`) ([v0.5.0](https://changelog.conductor.build/2025-06-18-conductor-v0.5.0), [v0.31.2](https://changelog.conductor.build/2025-09-17-conductor-v0.31.2), [v0.34.0](https://changelog.conductor.build/2025-11-11-conductor-v0.34.0)).

BYOK/provider routing is relatively mature for Claude-side compatibility: official provider docs cover OpenRouter, Bedrock, Vertex, Vercel AI Gateway, GLM, and Azure through environment-variable configuration ([Providers docs](https://docs.conductor.build/advanced/providers)). Privacy docs also claim model traffic goes directly to providers instead of passing through Conductor servers ([Privacy](https://docs.conductor.build/account/privacy)).

Limitations: no documented local/offline model runtime support, and the practical provider breadth remains narrower than "any agent CLI" ecosystems. Conductor is multi-provider, but not maximally open-ended.

---

## Pricing

| Plan | Price | Notes |
|------|-------|-------|
| Current product | Free | FAQ states "Right now we don’t" charge. |
| Future | Not publicly priced | FAQ says they may monetize collaboration/team features over time. |

Pricing controversy context: user complaints in community threads are more often about underlying model/API spend and session efficiency ("absurd costs") than Conductor subscription pricing itself ([Reddit thread](https://www.reddit.com/r/ClaudeAI/comments/1n3ejhr/conductor_the_first_multiclaude_app/)).

## Community Sentiment

### What people love
- "Been looking for something to run multiple claude code instances... Conductor strikes the right balance..." ([Reddit](https://www.reddit.com/r/ClaudeAI/comments/1n3ejhr/conductor_the_first_multiclaude_app/))
- "I've just started using it and liking it!" ([Reddit](https://www.reddit.com/r/ClaudeAI/comments/1n3ejhr/conductor_the_first_multiclaude_app/))
- HN reposted discussion praised local git compatibility and the reduced cloud lock-in versus browser-only products ([Alt-HN mirror](https://www.alternative.to/news/2025/6/show-hn-conductor-a-mac-app-that-lets-you-run-a-bunch-of-claude-codes-at-once)).

### Top complaints
1. Trust/closed-source concerns: "It really is amazing but how do we trust it, the code is closed?" ([Reddit](https://www.reddit.com/r/ClaudeAI/comments/1n3ejhr/conductor_the_first_multiclaude_app/))
2. Performance/memory complaints at higher session counts: "would love it to be more performant with multiple active sessions, it’s eating memory a lot." ([Reddit](https://www.reddit.com/r/ClaudeAI/comments/1n3ejhr/conductor_the_first_multiclaude_app/))
3. Stability critiques in comparison threads: "Conductor is super slow and buggy." ([Reddit](https://www.reddit.com/r/ClaudeCode/comments/1myad2h/conductor_vs_monospace_vs_opencode_vs_claudia_vs/))
4. Cost-efficiency frustration (agent usage economics): "absurd costs for a simple question..." ([Reddit](https://www.reddit.com/r/ClaudeAI/comments/1n3ejhr/conductor_the_first_multiclaude_app/))
5. Security model concern for enterprise users: FAQ confirms no additional sandboxing layer, which is powerful but increases need for careful local permission hygiene ([FAQ](https://docs.conductor.build/account/faq)).

---

## Sources

### Official
- https://www.conductor.build/: Product overview, positioning, supported agent families.
- https://docs.conductor.build/introduction/welcome: Core concept and docs index.
- https://docs.conductor.build/get-started/first-workspace: Workspace setup and workflow.
- https://docs.conductor.build/core/workspaces-and-branches: Branch/worktree model.
- https://docs.conductor.build/core/workspace-status: Status lifecycle model.
- https://docs.conductor.build/core/parallel-agents: Multi-agent parallel workflow.
- https://docs.conductor.build/core/testing: Browser/testing workflow references.
- https://docs.conductor.build/core/scripts: Run panel and scripts behavior.
- https://docs.conductor.build/core/diff-viewer: Diff review UX.
- https://docs.conductor.build/core/open-in-ide: External IDE handoff.
- https://docs.conductor.build/core/mcp: MCP client setup and operations.
- https://docs.conductor.build/advanced/providers: Provider/BYOK configuration.
- https://docs.conductor.build/account/privacy: Local storage vs cloud data policy.
- https://docs.conductor.build/account/faq: Pricing status, sandboxing, binaries/auth details.
- https://changelog.conductor.build/: Feature timeline and release history.
- https://changelog.conductor.build/2025-06-18-conductor-v0.5.0: GPT-5 addition and early shortcuts.
- https://changelog.conductor.build/2025-06-24-conductor-v0.8.0: Big terminal mode and review shortcuts.
- https://changelog.conductor.build/2025-08-13-conductor-v0.25.0: Workspace storage path and MCP status UI.
- https://changelog.conductor.build/2025-09-08-conductor-v0.29.4: Shortcut cheat sheet.
- https://changelog.conductor.build/2025-09-12-conductor-v0.30.0: Claude Code for Chrome + terminal/tab shortcuts.
- https://changelog.conductor.build/2025-09-16-conductor-v0.31.1: Checks tab and review flow shortcuts.
- https://changelog.conductor.build/2025-09-17-conductor-v0.31.2: Chat search navigation shortcuts.
- https://changelog.conductor.build/2025-10-24-conductor-v0.33.0: Task feature introduction.
- https://changelog.conductor.build/2025-11-11-conductor-v0.34.0: MCP reconnect and provider/model updates.
- https://changelog.conductor.build/2025-11-17-conductor-v0.35.0: Workspace status lanes.

### Community & Analysis
- https://www.reddit.com/r/ClaudeAI/comments/1n3ejhr/conductor_the_first_multiclaude_app/: Launch sentiment, trust/performance/cost feedback.
- https://www.reddit.com/r/ClaudeCode/comments/1myad2h/conductor_vs_monospace_vs_opencode_vs_claudia_vs/: Tool comparison and stability complaints.
- https://www.alternative.to/news/2025/6/show-hn-conductor-a-mac-app-that-lets-you-run-a-bunch-of-claude-codes-at-once: Mirror of HN discussion excerpts.

### Issues & Complaints
- https://www.reddit.com/r/ClaudeAI/comments/1n3ejhr/conductor_the_first_multiclaude_app/: Closed-source trust, memory pressure, cost complaints.
- https://www.reddit.com/r/ClaudeCode/comments/1myad2h/conductor_vs_monospace_vs_opencode_vs_claudia_vs/: "slow and buggy" report.

### Security
- https://docs.conductor.build/account/faq: No Conductor sandbox; agents run with user permissions.
- https://docs.conductor.build/account/privacy: Data handling and infra disclosures.
- No public Conductor-specific CVE disclosures were found in this research pass; absence should be treated as "not publicly disclosed," not proof of zero vulnerabilities.

### Press
- https://www.ycombinator.com/companies/conductor-2: Company profile and funding-stage context.

## Discrepancies with current table
- Resolved in this pass: `Kanban board` updated from `✗` to `~` in `website/comparison.html`.
- Resolved in this pass: `Local-first` updated from `✗` to `~`.
- Resolved in this pass: `MCP server` updated from `✗` to `~` (MCP client support, no exposed server).
- Resolved in this pass: `Embedded browser` updated from `✗` to `~` (Chrome-agent workflow, not full per-task embedded browser).
