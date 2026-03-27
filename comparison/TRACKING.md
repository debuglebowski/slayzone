# Comparison Tracking

This document tracks the status of the comparison program itself.

It exists because this is a long-term effort. We cannot migrate, normalize, and keep every competitor fresh in one session. The tracker makes the work incremental and keeps the corpus buildable over time.

## Status Legend

- `missing`
  - no canonical record exists yet
- `legacy-flat`
  - only the old flat markdown record exists
- `canon-draft`
  - folder-based canonical record exists but is incomplete
- `canon-reviewed`
  - canonical record exists and follows the guide
- `publish-ready`
  - canonical record is ready to drive public pages
- `stale`
  - canonical record exists but needs refresh

## Priority Legend

- `core`
  - direct positioning pressure or primary comparison anchors
- `high`
  - strategically adjacent and important to track
- `monitor`
  - useful context but lower urgency

## Wave 1: Core Competitors

| Competitor | Segment | Priority | Status | Freshness | Next step |
| --- | --- | --- | --- | --- | --- |
| Claude Code | CLI agent | core | legacy-flat | date not normalized | Migrate existing file into canonical folder. |
| OpenAI Codex | CLI agent | core | legacy-flat | date not normalized | Migrate existing file into canonical folder. |
| Codex Monitor | Codex orchestration app | core | publish-ready | 2026-03-27 | Done. |
| Jean | Desktop environment | core | canon-reviewed | 2026-03-27 | Capture product screenshot for publish-ready. |
| Conductor | Agent orchestrator | core | publish-ready | 2026-03-27 | Done. |
| VibeKanban | Agent orchestrator | core | publish-ready | 2026-03-27 | Done. |
| Superset.sh | Agent orchestrator | core | legacy-flat | 2026-02-28 in legacy file | Migrate existing detailed profile first-wave. |
| AutoClaude | Agent orchestrator | core | legacy-flat | 2026-02-28 in legacy file | Migrate existing detailed profile first-wave. |
| Maestro | Agent orchestrator | core | legacy-flat | 2026-02-28 in legacy file | Migrate existing detailed profile first-wave. |
| Cursor | AI IDE | core | legacy-flat | 2026-02-28 in legacy file | Migrate existing detailed profile first-wave. |
| Linear | PM | core | legacy-flat | 2026-02-28 in legacy file | Migrate existing detailed profile first-wave. |
| Zeroshot | Headless orchestrator | core | legacy-flat | 2026-02-28 in legacy file | Migrate existing detailed profile first-wave. |
| Polyscope | Agent-first dev environment | core | publish-ready | 2026-03-27 | Done. |

## Wave 2: High-Priority Strategic Adjacents

| Competitor | Segment | Priority | Status | Freshness | Next step |
| --- | --- | --- | --- | --- | --- |
| Devin | Cloud agent | high | legacy-flat | 2026-02-28 in legacy file | Migrate existing detailed profile after Wave 1. |
| Windsurf | AI IDE | high | legacy-flat | date not normalized | Migrate existing file into canonical folder. |
| GitHub Projects | PM | high | legacy-flat | date not normalized | Migrate existing file into canonical folder. |
| Jira | PM | high | legacy-flat | date not normalized | Migrate existing file into canonical folder. |
| Shortcut | PM | high | legacy-flat | date not normalized | Migrate existing file into canonical folder. |
| Plane.so | PM | high | legacy-flat | date not normalized | Migrate existing file into canonical folder. |
| AGOR | Orchestrator | high | legacy-flat | date not normalized | Migrate existing file into canonical folder. |
| Hephaestus | Orchestrator | high | legacy-flat | date not normalized | Migrate existing file into canonical folder. |
| OpenHands | Agent platform | high | legacy-flat | date not normalized | Migrate existing file into canonical folder. |
| TaskMaster AI | CLI + MCP | high | legacy-flat | date not normalized | Migrate existing file into canonical folder. |
| T3 Code | Lightweight agent GUI | high | missing | none | Create new canonical folder from scratch. |
| AutoMaker | Agent orchestrator | high | legacy-flat | date not normalized | Migrate existing file into canonical folder. |
| Lovable | App builder | high | legacy-flat | 2026-02-28 in legacy file | Migrate existing detailed profile with strong screenshot evidence. |

## Wave 3: Monitor

| Competitor | Segment | Priority | Status | Freshness | Next step |
| --- | --- | --- | --- | --- | --- |
| Zed | AI IDE | monitor | legacy-flat | date not normalized | Migrate if comparison surface expands. |
| GitHub Copilot | AI IDE extension | monitor | legacy-flat | date not normalized | Migrate if extension competitors become a stronger page cluster. |
| JetBrains AI | AI IDE plugin | monitor | legacy-flat | date not normalized | Migrate when JetBrains comparison view is needed. |
| Continue.dev | AI IDE extension | monitor | legacy-flat | date not normalized | Migrate when OSS IDE ecosystem needs fuller coverage. |
| Augment Code | AI IDE extension | monitor | legacy-flat | date not normalized | Migrate if task-centric editor competitors become more important. |
| Cline | AI IDE extension | monitor | legacy-flat | date not normalized | Migrate when extension-heavy view is needed. |
| Roo Code | AI IDE extension | monitor | legacy-flat | date not normalized | Migrate when extension-heavy view is needed. |
| Gemini CLI | CLI agent | monitor | legacy-flat | date not normalized | Migrate after Claude Code and Codex. |
| Amazon Q Developer | AI IDE / CLI | monitor | legacy-flat | date not normalized | Migrate if AWS-specific comparison demand appears. |
| Warp | Terminal | monitor | legacy-flat | date not normalized | Migrate when terminal-adjacent view is needed. |
| Wave Terminal | Terminal | monitor | legacy-flat | date not normalized | Migrate when browser-plus-terminal cluster is prioritized. |
| Pieces for Developers | Context tool | monitor | legacy-flat | date not normalized | Keep as context unless positioning expands. |
| Sweep AI | Automation plugin | monitor | legacy-flat | date not normalized | Keep as context unless issue-to-PR automation becomes central. |
| SWE-agent | Agent framework | monitor | legacy-flat | date not normalized | Migrate when framework comparisons matter publicly. |
| bolt.new | App builder | monitor | legacy-flat | date not normalized | Keep as contrast competitor. |
| v0.dev | App builder | monitor | legacy-flat | date not normalized | Keep as contrast competitor. |
| Superwhisper | Voice tool | monitor | legacy-flat | date not normalized | Keep as context only. |

## Corpus Cleanup

| Item | Status | Next step |
| --- | --- | --- |
| `comparison/_legacy/autoclaude.md` alias file | legacy-flat | Retire or convert to redirect note once `auto-claude` has a canonical folder. |
| Legacy flat-file corpus in `comparison/_legacy/` | active | Migrate incrementally by priority wave. |
| `comparison/_research/` narrative notes | active | Keep only market synthesis there; no source-of-truth tables. |

## Program Goals

The tracker is healthy when:

- all `core` competitors have folder-based canonical records
- all public comparison-table competitors are at least `canon-reviewed`
- missing high-priority competitors are visible here before they are forgotten
- freshness drift is visible instead of hidden inside the corpus
