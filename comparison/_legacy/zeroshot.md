# Zeroshot

> Last evaluated: 2026-02-28
> Website: https://github.com/covibes/zeroshot
> GitHub: https://github.com/covibes/zeroshot
> Stars: 2.1k
> License: MIT

## Summary
Zeroshot is an open-source, local CLI/TUI agent orchestrator from covibes focused on issue-driven coding loops (`plan -> execute -> blind validate`) rather than a visual project-management UI. It is strong on local execution, worktree isolation, and provider breadth, but weak on task-board UX and per-task visual tooling (browser/editor) compared with SlayZone.

## Datapoint Evaluation

| Feature | Verdict | Notes |
|---------|---------|-------|
| Kanban board | ✗ | No built-in kanban board; issue backends (GitHub/GitLab/Jira/Azure) are supported but not a board UI. |
| Local-first | ✓ | Local runtime, local SQLite + JSON settings in `~/.zeroshot`, BYOK model keys, no mandatory SaaS account. |
| MCP server | ✗ | No documented MCP server/client in README/docs; repo code search for `MCP` returns no repository results. |
| Keyboard-driven | ~ | CLI/TUI is keyboard-centric with many shortcuts, but keymap ergonomics are still evolving (input/shortcut conflict issues). |
| Terminal | ~ | Real terminal execution model (CLI subprocesses, worktree/docker runs), but no embedded per-task PTY panel like SlayZone cards. |
| Embedded browser | ✗ | No embedded browser/WebView feature documented or shipped. |
| Code editor | ✗ | No integrated code editor panel; editing is external (IDE/worktree files). |
| Git worktree isolation | ✓ | Core execution mode with per-task branch/worktree handling and Docker fallback paths. |
| Multi-provider AI agents | ✓ | Broad provider support (Anthropic, OpenAI, Google, OpenCode, OpenRouter, Qwen CLI, Ollama local, etc.). |

---

## Detailed Feature Analysis

### Kanban / Task Management
Zeroshot is explicitly positioned as a headless/local agent orchestrator, not a visual board app. The official README focuses on issue ingestion, CLI orchestration, and TUI monitoring rather than any drag-and-drop column workflow ([README](https://raw.githubusercontent.com/covibes/zeroshot/main/README.md), [repo home](https://github.com/covibes/zeroshot)). The project’s differentiator is issue-first execution loops (`zero run --issue ...` with plan/execute/validate), not card lifecycle management.

Issue backends are substantial (GitHub, GitLab, Jira, Azure DevOps), and that gives teams a PM integration surface, but it is not equivalent to a built-in kanban board. Zeroshot relies on external PM/issue systems for backlog/status visualization, whereas SlayZone’s board is native and central to workflow. Verdict remains `✗` for the website’s “Kanban board” axis.

### Local-First Architecture
Local-first is a real strength in Zeroshot. The project runs as local CLI/TUI software and stores state under `~/.zeroshot`, including multiple SQLite databases (`state.db`, `agents.db`, `memories.db`) and local settings JSON (`~/.zeroshot/settings.json`) according to the maintainer architecture notes ([AGENTS.md](https://raw.githubusercontent.com/covibes/zeroshot/main/AGENTS.md)). README and setup flows are BYOK-oriented, with environment variables for provider credentials rather than a mandatory Zeroshot-hosted account ([README](https://raw.githubusercontent.com/covibes/zeroshot/main/README.md), [providers docs](https://raw.githubusercontent.com/covibes/zeroshot/main/docs/providers.md)).

Offline behavior is mixed. Core orchestration/state handling is local, and local models via Ollama are supported, but most common model/provider paths still depend on remote APIs. In practical terms: “local-first” is accurate for data/control plane, while model inference is usually cloud unless users intentionally configure local providers. Compared to SlayZone, both are local-data oriented, but Zeroshot is more CLI-centric and less UI-driven.

### MCP Support
There is no official documentation for MCP server/client behavior in Zeroshot’s README, provider docs, or architecture notes ([README](https://raw.githubusercontent.com/covibes/zeroshot/main/README.md), [providers docs](https://raw.githubusercontent.com/covibes/zeroshot/main/docs/providers.md), [AGENTS.md](https://raw.githubusercontent.com/covibes/zeroshot/main/AGENTS.md)). The project’s integrations are issue backends and model providers, not an MCP tool/resource interface.

A direct repository code search URL for `MCP` in `covibes/zeroshot` does not surface repository code matches ([GitHub code search](https://github.com/covibes/zeroshot/search?q=MCP&type=code)). This is an inference from available public sources; if a private/experimental branch exists, it is not publicly documented as shipped.

### Keyboard-Driven
Zeroshot is keyboard-first by design. The Rust TUI input router includes global shortcuts like `Ctrl+S` (save session), `Ctrl+R` (refresh), `Ctrl+X` (cancel all), `Tab`/`Shift+Tab` (navigation), `a` (add task), and context-specific task keys (`j/k`, `Enter`, `Space`, `d`, `e`, `c`, `Ctrl+Up/Down`) ([tui-rs input.rs](https://raw.githubusercontent.com/covibes/zeroshot/main/tui-rs/src/input.rs)). The architecture doc also describes a command mode (`Ctrl+K`) and non-disruptive key handling model ([AGENTS.md](https://raw.githubusercontent.com/covibes/zeroshot/main/AGENTS.md)).

It is not full Vim compatibility. There are Vim-like motions (`j/k`) in task lists, but not full modal editing semantics. Community/issue history shows keyboard UX still being refined, including focus/shortcut conflicts (“global shortcuts should never disrupt typing”, “input buffer can lose input”), which justifies `~` rather than `✓` for parity with SlayZone’s keyboard expectations ([issue search: keyboard/focus](https://github.com/covibes/zeroshot/issues?q=is%3Aissue%20keyboard), [issue #83](https://github.com/covibes/zeroshot/issues/83)).

### Terminal
Zeroshot absolutely runs in real terminal environments. Its entire execution model is CLI-native, and task runs happen through local worktree/docker orchestration with real subprocesses rather than synthetic mocks ([README](https://raw.githubusercontent.com/covibes/zeroshot/main/README.md), [AGENTS.md](https://raw.githubusercontent.com/covibes/zeroshot/main/AGENTS.md)). It also exposes operational controls for approvals, retries, and loop orchestration in CLI/TUI.

However, against this comparison table’s intent (“real PTY terminal per task card”), Zeroshot is only partial. It does not present a SlayZone-style embedded per-task PTY panel inside a board card; it is a terminal product itself. Known execution edge cases in worktree/docker task runs (for example, “Failed to create or switch to worktree” and related state anomalies) also support a `~` verdict over `✓` ([issue #562](https://github.com/covibes/zeroshot/issues/562), [worktree issue search](https://github.com/covibes/zeroshot/issues?q=is%3Aissue%20worktree)).

### Embedded Browser
No embedded browser capability is documented in Zeroshot’s README, changelog, architecture notes, or codebase-facing docs ([README](https://raw.githubusercontent.com/covibes/zeroshot/main/README.md), [CHANGELOG](https://raw.githubusercontent.com/covibes/zeroshot/main/CHANGELOG.md), [AGENTS.md](https://raw.githubusercontent.com/covibes/zeroshot/main/AGENTS.md)). The shipped UI surface is terminal/TUI, not a Chromium/WebView pane.

The product direction through recent versions highlights issue backends, provider support, and TUI evolution, not in-app browsing. Compared with SlayZone, this is a clear gap for workflows that need doc/preview/PR browsing directly inside each task context.

### Code Editor
Zeroshot does not ship a first-class embedded code editor panel (Monaco/CodeMirror equivalent) in its current public product shape. The TUI supports task operations and can open tasks in an IDE, but code editing itself is external to Zeroshot’s interface ([tui-rs input.rs](https://raw.githubusercontent.com/covibes/zeroshot/main/tui-rs/src/input.rs), [README](https://raw.githubusercontent.com/covibes/zeroshot/main/README.md)).

That makes it fundamentally different from SlayZone’s in-card editor model. Zeroshot focuses on orchestration loops and automated agent execution, while review/edit steps live in user IDEs or git tooling. For this table’s “Code editor” row, verdict is `✗`.

### Git Worktree Isolation
Worktree isolation is core to Zeroshot’s design. Official docs and architecture notes explicitly describe isolated git worktrees as the default execution mode, with Docker as an alternative isolation path and issue-driven branch orchestration ([README](https://raw.githubusercontent.com/covibes/zeroshot/main/README.md), [AGENTS.md](https://raw.githubusercontent.com/covibes/zeroshot/main/AGENTS.md), [CHANGELOG](https://raw.githubusercontent.com/covibes/zeroshot/main/CHANGELOG.md)).

Operationally, this is real production behavior, not a marketing claim, but it has known edge cases. Recent issues document failures in worktree creation/switching and occasional state confusion in concurrent/task-id flows ([issue #562](https://github.com/covibes/zeroshot/issues/562), [worktree issue search](https://github.com/covibes/zeroshot/issues?q=is%3Aissue%20worktree)). Verdict remains `✓` because capability is shipped and central, with limitations noted.

### Multi-Provider AI Agents
Provider coverage is broad and well documented. Zeroshot supports major commercial providers and OSS/local routes, including Anthropic, OpenAI, Google, OpenCode, OpenRouter, Qwen CLI, and Ollama/local models; docs also list model-level mappings and capability differences ([providers docs](https://raw.githubusercontent.com/covibes/zeroshot/main/docs/providers.md), [capabilities.js](https://raw.githubusercontent.com/covibes/zeroshot/main/src/providers/capabilities.js), [README](https://raw.githubusercontent.com/covibes/zeroshot/main/README.md)).

BYOK is explicit: users configure provider keys/tokens locally via env/settings, and execution calls those providers directly from the client runtime. Practical limitations exist per provider (for example, image/JSON/tooling parity differs by backend), and some paths require local CLIs (OpenCode/Qwen). Still, on breadth and flexibility, Zeroshot is comparable to SlayZone and earns `✓`.

Model/provider list visible in docs includes (non-exhaustive but broad): Anthropic (Claude Sonnet/Opus families), OpenAI (GPT-5 family + o-series), Google Gemini 2.5 family, OpenCode engines (Anthropic/OpenAI/xAI/Gemini/Groq/OpenRouter), OpenRouter routing to many upstream models, local Ollama catalogs, and Qwen CLI/OpenAI-compatible endpoints ([providers docs](https://raw.githubusercontent.com/covibes/zeroshot/main/docs/providers.md)).

---

## Pricing
Zeroshot is OSS under MIT and does not currently publish paid tier plans for the core product.

| Plan | Price | Notes |
|------|-------|-------|
| OSS self-run (MIT) | $0 | Install via npm/homebrew; local CLI/TUI orchestration. |
| Provider/API usage | Variable | BYOK model costs billed by Anthropic/OpenAI/Google/OpenRouter/etc. |
| Optional infra (Docker/CI/issue backends) | Variable | Depends on user environment and third-party services. |

No major “pricing backlash” specific to Zeroshot plans was found in sampled community sources; discussion is mostly about capability quality/UX, not subscription pricing.

## Community Sentiment

### What people love
- Users repeatedly praise throughput and practical output quality for certain workflows:
  > "this is by far the best coding AI i've ever used for game dev ... the game changer."  
  Source: [r/cursor thread](https://www.reddit.com/r/cursor/comments/1jtr7m3/this_is_your_sign_to_use_zeroshot_and/)
- HN launch coverage framed Zeroshot as a serious “headless orchestrator” with broad model support and isolated execution:
  > "headless AI coding orchestrator with integrated issue management"  
  Source: [Show HN](https://news.ycombinator.com/item?id=46525642)
- Open-source credibility (MIT, public repo, active release cadence) is generally viewed positively by technical users:
  Source: [GitHub repo](https://github.com/covibes/zeroshot), [CHANGELOG](https://raw.githubusercontent.com/covibes/zeroshot/main/CHANGELOG.md)

### Top complaints
1. Reliability can degrade in complex/longer runs, according to user reports.
   > "its quality has gone down recently ... outputs get weird after some time."  
   Source: [r/ArtificialInteligence thread](https://www.reddit.com/r/ArtificialInteligence/comments/1je4esq/y_combinator_has_invested_in_zeroshot_an_open/)
2. Platform parity is still uneven (especially Windows), with maintainers explicitly deferring full support at times.
   > "full windows support has to be deferred to v4."  
   Source: [issue #83](https://github.com/covibes/zeroshot/issues/83)
3. Worktree/state edge cases continue to surface as real-world usage scales.
   > "Failed to create or switch to worktree ... duplicate task IDs."  
   Source: [issue #562](https://github.com/covibes/zeroshot/issues/562)

---

## Sources

### Official
- https://github.com/covibes/zeroshot: Repository overview (stars, license, positioning).
- https://raw.githubusercontent.com/covibes/zeroshot/main/README.md: Core features, workflows, issue backends, install/use patterns.
- https://raw.githubusercontent.com/covibes/zeroshot/main/CHANGELOG.md: Release timeline and shipped feature history.
- https://raw.githubusercontent.com/covibes/zeroshot/main/docs/providers.md: Provider/model matrix and BYOK configuration.
- https://raw.githubusercontent.com/covibes/zeroshot/main/src/providers/capabilities.js: Provider capability defaults.
- https://raw.githubusercontent.com/covibes/zeroshot/main/AGENTS.md: Architecture and local storage/runtime details.
- https://raw.githubusercontent.com/covibes/zeroshot/main/tui-rs/src/input.rs: TUI keyboard routing/shortcuts.

### Community & Analysis
- https://news.ycombinator.com/item?id=46525642: Show HN launch thread.
- https://www.reddit.com/r/cursor/comments/1jtr7m3/this_is_your_sign_to_use_zeroshot_and/: Positive user feedback thread.
- https://www.reddit.com/r/ArtificialInteligence/comments/1je4esq/y_combinator_has_invested_in_zeroshot_an_open/: Broader discussion with mixed sentiment.

### Issues & Complaints
- https://github.com/covibes/zeroshot/issues/83: Windows support deferral.
- https://github.com/covibes/zeroshot/issues/85: Windows path escaping bug.
- https://github.com/covibes/zeroshot/issues/562: Worktree creation/state inconsistency report.
- https://github.com/covibes/zeroshot/issues?q=is%3Aissue%20worktree: Worktree-related issue set.

### Security
- https://github.com/covibes/zeroshot/security: Advisories page (no published advisories visible at evaluation time).
- https://github.com/covibes/zeroshot/security/policy: Security reporting policy.
- https://nvd.nist.gov/vuln/search/results?query=zeroshot&search_type=all: NVD search (no clearly attributable CVE entries for `covibes/zeroshot` identified).

### Press
- https://www.ycombinator.com/companies/covibes/jobs: Company profile context referenced in community discussions.

## Discrepancies with current table
- Updated in this pass: Zeroshot `Terminal` changed from `✗` to `~` in `website/comparison.html` to reflect real terminal execution with non-card-based UX limitations.
- No remaining Zeroshot discrepancies detected at this evaluation depth.
