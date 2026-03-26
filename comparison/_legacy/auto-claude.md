# AutoClaude

> Last evaluated: 2026-02-28
> Website: https://www.auto-claude.com
> GitHub: https://github.com/AndyMik90/Auto-Claude
> Stars: 3.6k (GitHub UI on 2026-02-28)
> License: MIT

## Summary
Auto-Claude is an Electron desktop orchestrator focused on parallel Claude Code task execution with Kanban-style workflow and git worktree isolation. It has grown from Claude-only automation into a hybrid stack with optional provider integrations (OpenRouter/custom Anthropic-compatible endpoints) but still centers its core coding loop around Claude Code.

## Datapoint Evaluation

| Feature | Verdict | Notes |
|---------|---------|-------|
| Kanban board | ✓ | Native board/task orchestration is a core product capability. |
| Local-first | ~ | Local desktop app and local memory files, but core coding flow depends on Claude auth/cloud APIs. |
| MCP server | ~ | Strong MCP client/tool integration (dynamic injection, Electron MCP), but no clear evidence of exposing a general-purpose MCP server endpoint for external clients. |
| Keyboard-driven | ~ | Some documented shortcuts and keyboard controls exist, but no complete shortcut matrix and keyboard-first coverage appears incomplete. |
| Terminal | ✓ | Real command execution and agent terminal flows are core; multiple release notes and bugfixes target terminal behavior. |
| Embedded browser | ✗ | No evidence of a first-class embedded Chromium/WebView panel per task; only browser-tool references inside agent flows. |
| Code editor | ~ | File explorer/files tab and diff/review improvements exist, but not a fully documented IDE-grade embedded editor workflow. |
| Git worktree isolation | ✓ | Explicitly marketed and repeatedly improved (recovery manager, branch/worktree robustness). |
| Multi-provider AI agents | ~ | Claude Code remains central, but OpenRouter, custom Anthropic-compatible APIs, and multiple embedding/LLM provider paths are now supported with constraints. |

---

## Detailed Feature Analysis

### Kanban / Task Management
Auto-Claude ships a native Kanban-style task system rather than requiring external PM tools. The README explicitly positions it as “AI-Powered Kanban Development” and highlights running up to 12 parallel agents with task-level organization and project tracking in a single UI. That puts it closer to agent orchestration products than single-chat coding assistants. Sources: https://github.com/AndyMik90/Auto-Claude, https://www.auto-claude.com

Release history also reinforces that the board/task layer is an actively maintained surface, not a static marketing page. Recent releases include project dashboard improvements, task ordering controls, and task creation flow updates (including keyboard-triggered creation and markdown/subtask formatting fixes), indicating frequent iteration on planning/coordination UX. Sources: https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.6.1, https://github.com/AndyMik90/Auto-Claude/releases?page=2

Compared with SlayZone, Auto-Claude is strong on “many parallel tasks/agents in a board,” but weaker on deep per-task environment parity (browser/editor/tooling isolation all in one card). SlayZone’s comparison claim (“all terminal/browser/editor/worktree per task”) remains a meaningful differentiation axis even where Auto-Claude has matured its board UX. Source: https://github.com/AndyMik90/Auto-Claude

### Local-First Architecture
Auto-Claude is distributed as a local desktop app (Electron + React + TypeScript + Node backend), and key state/memory artifacts are stored locally. Releases explicitly document local memory persistence under `~/.auto-claude/memories/` and mention local-memory query optimizations, indicating real local data ownership rather than purely cloud-hosted state. Sources: https://github.com/AndyMik90/Auto-Claude, https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.3

At the same time, the core coding path depends heavily on Claude Code authentication/session health and provider APIs. Multiple releases include fixes for authentication breakage, API key lifecycle, and session invalidation behavior; that is a practical signal that “offline-first, no-account” is not the operating model for primary usage. Sources: https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.5, https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.4

Privacy and deployment are hybrid: local app plus optional remote services. Example: a “remote memory sync service” was introduced to sync memories to a cloud endpoint, while users can also run without external vector DB by using new in-app DB modes added in v2.6.3. So Auto-Claude is best described as local-heavy but cloud-dependent for core agent intelligence. Sources: https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.3, https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.6.3

### MCP Support
MCP capability in Auto-Claude appears focused on client-side tool consumption rather than exposing a standalone server surface. Release notes describe “dynamic MCP tool injection,” “Electron MCP support,” and a custom MCP profile manager that lets users configure and inject toolsets at runtime. Sources: https://github.com/AndyMik90/Auto-Claude/releases?page=3, https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.5

That is valuable for extensibility, but available sources do not clearly document a user-facing MCP server endpoint, transport contract, or externally consumable resource schema analogous to “run Auto-Claude as an MCP server for other clients.” In other words, MCP is present, but primarily as internal/agent tooling integration in the examined materials. Sources: https://github.com/AndyMik90/Auto-Claude/releases?page=3, https://github.com/AndyMik90/Auto-Claude

Relative to SlayZone’s “MCP server” row definition, this lands as partial: robust MCP-client/tool profile mechanics, unclear server-exposure semantics. If a public server mode exists, it was not clearly verifiable in current docs/releases. Source: https://github.com/AndyMik90/Auto-Claude

### Keyboard-Driven
Keyboard support is present but only partially documented. Release notes reference explicit shortcuts such as task creation with `Cmd/Ctrl+Shift+A` and a hotkey migration from `Ctrl+P` to `Ctrl+Shift+P`, plus mentions of manual keyboard controls in agent views. Sources: https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.6.1, https://github.com/AndyMik90/Auto-Claude/releases?page=2

However, a complete centralized shortcut inventory (global navigation, board manipulation, modal controls, task traversal, agent/session controls) was not found in the evaluated sources. This creates a practical gap versus products that publish a full keyboard command map and keyboard-first interaction philosophy. Sources: https://github.com/AndyMik90/Auto-Claude, https://github.com/AndyMik90/Auto-Claude/releases

Vim-mode behavior/conflicts were also not clearly documented in primary material reviewed. So the evidence supports “has useful shortcuts,” but not “fully keyboard-driven across the entire product surface.” Source: https://github.com/AndyMik90/Auto-Claude/releases

### Terminal
Terminal execution is core to Auto-Claude’s architecture because it orchestrates Claude Code and related agent/tool commands in local task workspaces. The README and release stream repeatedly reference terminal command processing, command deduplication, and command preview/review flows, which indicates first-class execution plumbing rather than simulated output panes. Sources: https://github.com/AndyMik90/Auto-Claude, https://github.com/AndyMik90/Auto-Claude/releases?page=2

Operationally, release notes include terminal-focused fixes such as command processing reliability, duplicate command prevention, terminal copy/paste handling, and broader process cleanup to prevent ghost processes. That pattern is consistent with real PTY/subprocess-heavy behavior where reliability work is ongoing. Sources: https://github.com/AndyMik90/Auto-Claude/releases?page=2, https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.3

Limitations and risk signals are visible in issue history (for example, freezing or broken onboarding paths tied to key/session setup). So terminal capability is strong, but day-to-day stability has historically depended on quick release cadence and bugfix turnover. Sources: https://github.com/AndyMik90/Auto-Claude/issues/226, https://github.com/AndyMik90/Auto-Claude/releases

### Embedded Browser
The evaluated sources do not show a dedicated embedded browser panel equivalent to per-task Chromium/WebView tabs. No official feature documentation was found for integrated browsing UI with mobile emulation/devtools as a core task pane. Sources: https://github.com/AndyMik90/Auto-Claude, https://github.com/AndyMik90/Auto-Claude/releases

Some release notes mention browser-related tooling inside agent QA/tool-selection flows (for example, fixes around browser tool selection), but this appears to describe tool invocation behavior rather than a persistent in-app browsing workspace for users. Source: https://github.com/AndyMik90/Auto-Claude/releases?page=2

Compared to SlayZone’s explicit embedded-browser-per-task claim, Auto-Claude currently appears weaker here based on verifiable public documentation. Source: https://github.com/AndyMik90/Auto-Claude

### Code Editor
Auto-Claude has added significant file-surface improvements over time: file explorer integration, files tab functionality in task detail, and diff/summary enhancements in release notes. This indicates meaningful progress beyond “chat only,” especially for inspecting and coordinating multi-file task outputs. Sources: https://github.com/AndyMik90/Auto-Claude/releases?page=4, https://github.com/AndyMik90/Auto-Claude/releases?page=2

Still, available primary sources do not clearly document a full embedded editor workflow with mature multi-file editing UX, conflict resolution ergonomics, and explicit accept/reject patch flows comparable to editor-centric tools. The strongest evidence supports “file visibility/review and management features,” not a clearly positioned IDE-grade internal editor. Sources: https://github.com/AndyMik90/Auto-Claude, https://github.com/AndyMik90/Auto-Claude/releases

This puts Auto-Claude in partial territory for the comparison row: more than no editor surface, less than a deeply documented integrated coding editor stack. Source: https://github.com/AndyMik90/Auto-Claude/releases

### Git Worktree Isolation
Git worktree isolation is one of Auto-Claude’s clearest strengths. The README explicitly states isolated workspaces and branch-safe parallel execution, and release notes repeatedly include worktree/branch lifecycle fixes, recovery handling, and worktree robustness improvements. Sources: https://github.com/AndyMik90/Auto-Claude, https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.5

Implementation details suggest practical, long-running usage: explicit worktree recovery manager work, stale task/worktree cleanup, and constraints like branch-name matching rules for cache lookup (with relevant bug fixes when behavior diverged). This is beyond “manual git tips” and into dedicated orchestration logic. Sources: https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.5, https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.4

Compared with SlayZone, Auto-Claude is genuinely competitive on this datapoint and should be marked supported in the table. Source: https://github.com/AndyMik90/Auto-Claude

### Multi-Provider AI Agents
Auto-Claude started as Claude-centric orchestration, and that remains foundational (the project still emphasizes Claude Code setup/auth as core). But releases in 2025 expanded provider flexibility: OpenRouter support for LLM and embeddings, custom Anthropic-compatible API endpoints, and model auto-sync from provider APIs. Sources: https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.2, https://github.com/AndyMik90/Auto-Claude/releases?page=3

Provider/model evidence in public issues and release notes includes Anthropic Claude variants and third-party models routed through OpenRouter; a user report references options like `openai/gpt-oss-120b`, `qwen/qwen3-coder`, `anthropic/claude-sonnet-4.5`, and `google/gemini-2.5-flash` in model preferences. This demonstrates practical multi-provider surface area, though not all modes/features are equally robust yet. Source: https://github.com/AndyMik90/Auto-Claude/issues/446

Local model support appears partially available via provider-path integrations (community asks around Ollama and MCP/provider profiles), but documentation still centers cloud-provider workflows. Net: materially beyond Claude-only, but not yet “fully frictionless multi-provider everywhere.” Sources: https://github.com/AndyMik90/Auto-Claude/discussions/668, https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.2

---

## Pricing

| Plan/Cost Element | Price | Notes |
|---|---:|---|
| Auto-Claude app | Free | Open-source MIT project. |
| Claude access | External subscription/API cost | README and onboarding flows depend on Claude Code auth/session; user needs Anthropic access path. |
| Optional provider costs | Usage-based | OpenRouter/custom provider/vector DB integrations can add separate spend. |

Pricing controversy pattern: users generally praise the app being free/open, but some complain about setup confusion when “free” expectations collide with external API/subscription requirements. Sources: https://github.com/AndyMik90/Auto-Claude, https://news.ycombinator.com/item?id=45149602

## Community Sentiment

### What people love
- Fast iteration cadence and visible maintainer responsiveness in release stream and issue triage. Sources: https://github.com/AndyMik90/Auto-Claude/releases, https://github.com/AndyMik90/Auto-Claude/issues
- Parallel task/worktree workflow solves branch/task context switching for some users. Source: https://www.reddit.com/r/ClaudeAI/comments/1n9hycb/is_autoclaude_getting_better/
- Early HN feedback highlighted appreciation for open source direction and local desktop packaging. Source: https://news.ycombinator.com/item?id=45149602

### Top complaints
1. Stability regressions during fast release cycles (auth/session invalidation, update issues, freezes).
   > “App freezes when I get to the API Key and using head over to onboarding.”
   Source: https://github.com/AndyMik90/Auto-Claude/issues/226
2. Provider/model preference mismatches and inconsistent model persistence in some versions.
   > “Model preferences not applying correctly with OpenRouter provider settings.”
   Source: https://github.com/AndyMik90/Auto-Claude/issues/446
3. Free-vs-paid expectation mismatch during onboarding/setup.
   > “If this costs money, it’s not free.”
   Source: https://news.ycombinator.com/item?id=45149602

Representative positive quote:
> “After 2 days using it, I think it's near perfect... [it] got rid of branch confusion...”
Source: https://www.reddit.com/r/ClaudeAI/comments/1n9hycb/is_autoclaude_getting_better/

---

## Sources

### Official
- https://github.com/AndyMik90/Auto-Claude: Main README, architecture summary, licensing, feature claims
- https://www.auto-claude.com: Product site/docs entry point
- https://github.com/AndyMik90/Auto-Claude/releases: Release stream and changelog trail
- https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.5: Latest fixes (worktree reliability, auth/session)
- https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.4: Security scanning and session/API fixes
- https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.3: Local/remote memory architecture update
- https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.7.2: OpenRouter/custom provider support
- https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.6.3: In-app DB option, provider expansion details
- https://github.com/AndyMik90/Auto-Claude/releases/tag/v2.6.1: Keyboard shortcut/task UX updates

### Community & Analysis
- https://www.reddit.com/r/ClaudeAI/comments/1n9hycb/is_autoclaude_getting_better/: User experience thread with strengths/limitations
- https://www.reddit.com/r/ClaudeAI/comments/1mp7h9x/thoughts_on_autoclaude/: Perception/discussion thread
- https://news.ycombinator.com/item?id=45149602: Show HN launch discussion and feedback

### Issues & Complaints
- https://github.com/AndyMik90/Auto-Claude/issues/226: Freeze/onboarding reliability complaint
- https://github.com/AndyMik90/Auto-Claude/issues/337: Task page/session persistence issue
- https://github.com/AndyMik90/Auto-Claude/issues/355: Version update mismatch issue
- https://github.com/AndyMik90/Auto-Claude/issues/446: OpenRouter model preference issue
- https://github.com/AndyMik90/Auto-Claude/discussions/668: Community request around Ollama/provider usage

### Security
- https://github.com/AndyMik90/Auto-Claude/security: Security advisories page (none published at evaluation time)
- https://nvd.nist.gov/vuln/search/results?query=Auto-Claude&search_type=all&isCpeNameSearch=false: CVE query reference (no obvious direct Auto-Claude listing observed)

### Press
- https://theaireport.ai/newsletter/multi-agent-coding-made-easy-with-auto-claude: Third-party coverage

## Discrepancies with current table
- `Local-first`: table shows ✗; evidence supports `~` (local-heavy architecture with cloud dependencies).
- `Keyboard-driven`: table shows ✗; evidence supports `~` (documented shortcuts exist, but not comprehensive keyboard-first coverage).
- `Code editor`: table shows ✗; evidence supports `~` (files tab/file explorer/diff-related features, but not full IDE-grade editor).
- `Git worktree isolation`: table shows ✗; evidence supports `✓` (core documented feature with ongoing reliability work).
- `Multi-provider AI agents`: table shows ✗; evidence supports `~` (OpenRouter/custom provider support exists, though Claude-centric constraints remain).
