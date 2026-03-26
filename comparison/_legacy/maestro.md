# Maestro

> Last evaluated: 2026-02-28
> Website: https://runmaestro.ai
> GitHub: https://github.com/RunMaestro/Maestro
> Stars: 4.8k
> License: AGPL-3.0

## Summary
Maestro is an Electron desktop orchestrator for coding agents (Claude Code, Codex, Gemini CLI, OpenCode, Goose, and others) with real PTY terminals, session tabs, and git worktree workflows. It is strong for multi-agent execution and local control, but it is not a project/task manager and does not offer SlayZone-style per-task isolation with embedded browser + task board primitives. ([GitHub repo](https://github.com/RunMaestro/Maestro), [Quick Start](https://docs.runmaestro.ai/guides/quick-start))

## Datapoint Evaluation

| Feature | Verdict | Notes |
|---------|---------|-------|
| Kanban board | ✗ | No built-in kanban/backlog workflow; Maestro uses project/session tabs instead of task cards. ([README features](https://github.com/RunMaestro/Maestro), [Issue #1218](https://github.com/RunMaestro/Maestro/issues/1218)) |
| Local-first | ✓ | Local SQLite DB + local stores in app userData, optional remote tunnel via ngrok, API keys in OS keychain. ([connection.ts](https://github.com/RunMaestro/Maestro/blob/main/src/main/database/connection.ts), [db-path.ts](https://github.com/RunMaestro/Maestro/blob/main/src/main/database/utils/db-path.ts), [remote access docs](https://docs.runmaestro.ai/advanced/remote-access), [api-key-service.ts](https://github.com/RunMaestro/Maestro/blob/main/src/main/services/api-key-service.ts)) |
| MCP server | ~ | Built-in MCP server exists (beta) with session/terminal/file tools, but scope is session-centric and docs call out capability limits. ([MCP server docs](https://docs.runmaestro.ai/cli/mcp-server), [provider notes](https://docs.runmaestro.ai/advanced/provider-notes)) |
| Keyboard-driven | ~ | Extensive app shortcuts and command palette exist, but keyboard behavior is inconsistent in some flows and no native vim keybinding layer for app UI. ([use-keyboard-shortcuts.ts](https://github.com/RunMaestro/Maestro/blob/main/src/renderer/src/hooks/use-keyboard-shortcuts.ts), [keyboard docs](https://docs.runmaestro.ai/guides/keyboard-shortcuts), [Issue #977](https://github.com/RunMaestro/Maestro/issues/977), [Issue #899](https://github.com/RunMaestro/Maestro/issues/899)) |
| Terminal | ✓ | Uses real `node-pty` shell processes (not simulated output); supports split terminals and command execution from agents. ([process-manager.ts](https://github.com/RunMaestro/Maestro/blob/main/src/main/pty/process-manager.ts), [README](https://github.com/RunMaestro/Maestro)) |
| Embedded browser | ✗ | No built-in per-session Chromium/webview panel for browsing/docs/preview; browser integration is a user-requested gap. ([README features](https://github.com/RunMaestro/Maestro), [Issue #1218](https://github.com/RunMaestro/Maestro/issues/1218), [remote access docs](https://docs.runmaestro.ai/advanced/remote-access)) |
| Code editor | ~ | Built-in file preview/editor/diff exists (CodeMirror + language extensions), but it is lightweight compared to full IDE-level editing workflows. ([FilePreview.tsx](https://github.com/RunMaestro/Maestro/blob/main/src/renderer/src/components/sessions/FilePreview.tsx), [README](https://github.com/RunMaestro/Maestro)) |
| Git worktree isolation | ✓ | Native git worktree manager with automated branch/worktree naming and assignment per session. ([worktree docs](https://docs.runmaestro.ai/guides/worktree-integration), [worktree-manager.ts](https://github.com/RunMaestro/Maestro/blob/main/src/main/git/worktree-manager.ts)) |
| Multi-provider AI agents | ✓ | Broad multi-mode support across major agent CLIs with provider-specific BYOK behavior and optional custom mode args/env. ([provider notes](https://docs.runmaestro.ai/advanced/provider-notes), [mode config](https://github.com/RunMaestro/Maestro/blob/main/src/shared/mode-config.ts), [configuration](https://docs.runmaestro.ai/advanced/configuration)) |

---

## Detailed Feature Analysis

### Kanban / Task Management
Maestro currently models work as **projects + sessions + tabs**, not cards on a kanban board. Official product positioning and README focus on launching and orchestrating coding agents, with features like tabs, split terminals, playbooks, worktree integration, and AI provider modes; there is no board/backlog/status column primitive in official docs. ([GitHub repo](https://github.com/RunMaestro/Maestro), [Quick Start](https://docs.runmaestro.ai/guides/quick-start))

Because there is no first-class task object, teams generally emulate task tracking through session naming conventions and git branches. This works for power users, but there is no drag-and-drop status workflow, no WIP lane controls, and no status schema comparable to SlayZone task states. The open issue requesting browser integration also frames Maestro as currently missing adjacent task execution surfaces users expect in “all-in-one” workflows. ([Issue #1218](https://github.com/RunMaestro/Maestro/issues/1218))

Compared with SlayZone, Maestro is stronger as a **session orchestrator** than as a **task management product**. SlayZone’s differentiation remains task-level state and per-card tool isolation, while Maestro optimizes for launching many agent sessions quickly.

### Local-First Architecture
Maestro is materially local-first in implementation. The main app initializes a local SQLite connection using TypeORM and `better-sqlite3`, with the DB path resolved under Electron `app.getPath('userData')` as `maestro.db`. Schema migrations include persistent project/session/message/worktree context tables and token/accounting tables. ([connection.ts](https://github.com/RunMaestro/Maestro/blob/main/src/main/database/connection.ts), [db-path.ts](https://github.com/RunMaestro/Maestro/blob/main/src/main/database/utils/db-path.ts), [migration](https://github.com/RunMaestro/Maestro/blob/main/src/main/database/migrations/1737270000000-AddProjectAndSessionContext.ts))

In addition to SQLite, Maestro persists app state via Electron Store-backed handlers (`settings`, `sessions`) in the local user data directory. That gives a mixed storage model: structured relational history in SQLite plus JSON-ish app state for UI/session persistence. API keys are not stored in plaintext app config; they are written to OS credential storage via `keytar`. ([persistence-handlers.ts](https://github.com/RunMaestro/Maestro/blob/main/src/main/ipc/persistence-handlers.ts), [settings-store.ts](https://github.com/RunMaestro/Maestro/blob/main/src/main/persistence/settings-store.ts), [session-store.ts](https://github.com/RunMaestro/Maestro/blob/main/src/main/persistence/session-store.ts), [api-key-service.ts](https://github.com/RunMaestro/Maestro/blob/main/src/main/services/api-key-service.ts))

Cloud dependency is optional for remote control: Remote Access uses an ngrok websocket tunnel to expose local sessions to a phone browser, with one-time passcodes and local websocket connectivity. This is not a mandatory cloud sync system, but it does add an external tunnel in that mode. Relative to SlayZone: both are local-first, but SlayZone couples locality to task entities; Maestro couples locality to sessions and projects. ([remote access docs](https://docs.runmaestro.ai/advanced/remote-access))

### MCP Support
Maestro now ships a first-party MCP server (`npx maestro-cli mcp-server --session-mode`) and documents integration with Claude Desktop and Cursor config files. Official tooling includes session lifecycle, prompt sending, terminal command execution, and file read/write/list operations. That is meaningful MCP server support, not just MCP client passthrough. ([MCP server docs](https://docs.runmaestro.ai/cli/mcp-server))

Verdict is partial (not full) because docs explicitly describe it as beta-ish and constrained: “not all desktop app features” are exposed, and some tools are “minimal implementation.” The current shape is practical for remote automation, but narrower than a domain-aware task server. Resource-oriented semantics and task-status primitives (core to SlayZone’s MCP framing) are not the focus of Maestro MCP today. ([MCP server docs](https://docs.runmaestro.ai/cli/mcp-server))

Maestro also supports MCP in client mode across several agent integrations (provider notes mention MCP support by mode). So it can both expose and consume MCP capabilities, but server depth is session-centric rather than project/task-centric. ([provider notes](https://docs.runmaestro.ai/advanced/provider-notes))

### Keyboard-Driven
Maestro has a substantial keyboard surface in code and docs. Core navigation includes tab switching (`Cmd/Ctrl+1..9`, `Cmd/Ctrl+Tab`), project/session creation (`Cmd/Ctrl+N`, `Cmd/Ctrl+T`), tab lifecycle (`Cmd/Ctrl+W`, `Cmd/Ctrl+Shift+W`, `Cmd/Ctrl+Shift+T`), and operational controls like command palette, split terminals, terminal duplication, diff view, and shortcuts modal. ([use-keyboard-shortcuts.ts](https://github.com/RunMaestro/Maestro/blob/main/src/renderer/src/hooks/use-keyboard-shortcuts.ts), [keyboard docs](https://docs.runmaestro.ai/guides/keyboard-shortcuts))

Shortcut coverage is strong for session orchestration, but community reports show inconsistencies and gaps. Example complaints include shortcuts acting only on active tab context and hotkey mismatches during project creation flow. Representative issue quotes include: “keyboard shortcuts should work regardless of tab currently active” and “cmd+n should always open the new project dialog.” ([Issue #977](https://github.com/RunMaestro/Maestro/issues/977), [Issue #899](https://github.com/RunMaestro/Maestro/issues/899))

Vim compatibility is not an app-level feature in docs (no native vim-navigation mode for Maestro UI). Users can run vim/neovim inside PTY terminals, but that is terminal-level behavior, not full keyboard-first app navigation parity. Compared to SlayZone, Maestro is keyboard-capable but remains session-window oriented versus task-board keyboard orchestration.

**Shortcut list (current app-level map in source):**
- `Cmd/Ctrl+1..9`: Activate tab index
- `Cmd/Ctrl+Tab`: Next tab
- `Cmd/Ctrl+Shift+Tab`: Previous tab
- `Cmd/Ctrl+T`: New session tab
- `Cmd/Ctrl+N`: New project dialog
- `Cmd/Ctrl+W`: Close tab
- `Cmd/Ctrl+R`: Rename tab
- `Cmd/Ctrl+Shift+W`: Close all tabs
- `Cmd/Ctrl+Shift+T`: Restore closed tab
- `Cmd/Ctrl+L`: Clear terminal
- `Ctrl+\``: Split terminal
- `Ctrl+Shift+\``: Toggle split orientation
- `Ctrl+Shift+ArrowUp/ArrowDown`: Navigate terminal splits
- `Ctrl+D`: Duplicate terminal split
- `Ctrl+Shift+W`: Close active split
- `Ctrl+Shift+N`: New native terminal
- `Ctrl+Alt+F`: Open file preview
- `Ctrl+Shift+D`: Show all diffs
- `Ctrl+F`: Find in messages
- `Ctrl+Shift+P`: Command palette
- `Shift+/`: Shortcuts modal

### Terminal
Maestro’s terminal is a real PTY abstraction in Electron main process (`node-pty` spawn), with shell path resolution from user env and cwd assignment to the active worktree path when available. This is not a mock terminal panel. It supports streaming output events, command execution, and split management from UI. ([process-manager.ts](https://github.com/RunMaestro/Maestro/blob/main/src/main/pty/process-manager.ts), [README](https://github.com/RunMaestro/Maestro))

Session-level terminal behavior is mature (tabs, splits, command control), but isolation semantics differ from SlayZone’s per-task model. In Maestro, terminals are tied to sessions/projects and optionally worktrees; they are not task-card-scoped containers with task metadata ownership.

Sandboxing is mostly delegated to the underlying agent CLI/tooling rather than enforced as a Maestro-wide hardened sandbox layer in docs. For “YOLO”-style auto-execution, users typically pass model/tool-specific flags through custom mode args/env (`MODE_DEFAULT_ARGS`, `MODE_ENV`, explicit Codex/Claude flags in examples). That is flexible but less opinionated than a product-level permission model. ([configuration](https://docs.runmaestro.ai/advanced/configuration), [README quick commands](https://github.com/RunMaestro/Maestro))

### Embedded Browser
Maestro does not currently provide a built-in, task/session-embedded browser panel analogous to a Chromium tab in the coding workspace. Official features list file preview, terminal, chat modes, and worktree integration, but no in-app browser execution surface. ([README](https://github.com/RunMaestro/Maestro), [quick start docs](https://docs.runmaestro.ai/guides/quick-start))

Community demand exists. A direct request asks to “integrate browser use in main app” to avoid switching context while coding with agents. That request itself is evidence this capability is not first-class today. ([Issue #1218](https://github.com/RunMaestro/Maestro/issues/1218))

Remote Access should not be confused with embedded browser support: it exposes the Maestro UI to mobile via tunnel and passcode, but it is remote control of the desktop app, not an internal browser tool in each coding context. Compared with SlayZone, this is a concrete gap for per-task research/test flows. ([remote access docs](https://docs.runmaestro.ai/advanced/remote-access))

### Code Editor
Maestro includes a built-in lightweight editor/diff flow in the session UI. The `FilePreview` component uses CodeMirror and language extensions, supports read/write via IPC, and can apply edits back to the worktree file. This supports practical in-app review and quick patches. ([FilePreview.tsx](https://github.com/RunMaestro/Maestro/blob/main/src/renderer/src/components/sessions/FilePreview.tsx))

It is not positioned as a full IDE replacement: the UI also offers “open in your editor” handoff, which implies Maestro expects collaboration with external editors for deep coding sessions. This aligns with Maestro’s core identity as an orchestrator shell around agent CLIs rather than a full editor platform. ([README](https://github.com/RunMaestro/Maestro))

Compared with SlayZone, Maestro’s editor story is functionally useful but session-centric and lighter. SlayZone’s differentiator remains tight task-coupled editing context and task lifecycle integration around each code change.

### Git Worktree Isolation
Maestro has robust first-party worktree support. Docs describe one-click/session-level setup and branch+worktree naming patterns tied to session identity; source code shows worktree create/list/cleanup utilities with base path management and active-path routing. This is true isolation for concurrent agent sessions. ([worktree docs](https://docs.runmaestro.ai/guides/worktree-integration), [worktree-manager.ts](https://github.com/RunMaestro/Maestro/blob/main/src/main/git/worktree-manager.ts))

The system is practical for parallel coding and branch hygiene, but merge-back orchestration is still primarily standard Git workflow (commit/merge/rebase/PR), not a task-graph merge product. Users still manage conflict resolution at git level, which is fine for engineering users but less guided than PM-style task pipelines.

Relative to SlayZone, Maestro is strong on worktree mechanics but not on attaching that isolation to canonical task objects with board-level visibility and metadata history.

### Multi-Provider AI Agents
Maestro supports a broad mode roster across multiple agent ecosystems (Claude Code, Codex, Gemini CLI, OpenCode, Crush, Amp, Qwen Code, Goose, Cursor Agent, Grok Code Fast, Grok Code). Provider notes and shared mode config show explicit mode metadata and key requirements. ([provider notes](https://docs.runmaestro.ai/advanced/provider-notes), [mode config](https://github.com/RunMaestro/Maestro/blob/main/src/shared/mode-config.ts))

BYOK is mode-specific, not uniform. Some modes require provider API keys, some are optional, and some rely on local app auth or account linking. Configuration supports per-mode env vars and default args, which enables custom gateways, provider routing, and “dangerous” auto-run flags where the underlying CLI permits it. ([provider notes](https://docs.runmaestro.ai/advanced/provider-notes), [configuration](https://docs.runmaestro.ai/advanced/configuration))

Data path depends on selected mode: Maestro orchestrates and displays sessions locally, but model inference travels through whichever backend the mode/CLI uses (Anthropic, OpenAI, Google, xAI, OpenRouter, local backends where supported by that mode). So compared to SlayZone, Maestro is highly flexible on provider choice but has more heterogeneous behavior/limits because it wraps many external CLIs.

**Mode coverage table (official docs + mode config):**

| Mode | Default model (documented) | BYOK shape | Notes |
|------|-----------------------------|------------|-------|
| Claude Code | Claude Sonnet 4 | Provider key (`ANTHROPIC_API_KEY`) | Alt model: Claude Opus 4. ([provider notes](https://docs.runmaestro.ai/advanced/provider-notes)) |
| Codex | GPT-5-Codex | Provider key (`OPENAI_API_KEY`) | Alt model: GPT-5. ([provider notes](https://docs.runmaestro.ai/advanced/provider-notes)) |
| Gemini CLI | Gemini 2.5 Pro | Provider key (`GEMINI_API_KEY`) | Google auth flow. ([provider notes](https://docs.runmaestro.ai/advanced/provider-notes)) |
| Qwen Code | `qwen3-coder-plus` | Provider key (`QWEN_CODE_API_KEY`) | Alternatives listed in docs. ([provider notes](https://docs.runmaestro.ai/advanced/provider-notes)) |
| Goose | `claude-sonnet-4` | Provider-optional | Anthropic-first setup in docs. ([provider notes](https://docs.runmaestro.ai/advanced/provider-notes)) |
| Cursor Agent | Cursor account auth | No standalone provider key in Maestro | Requires Cursor app login/state. ([provider notes](https://docs.runmaestro.ai/advanced/provider-notes)) |
| Grok Code Fast | `grok-code-fast-1` | Provider key (`XAI_API_KEY`) | Cost/perf tradeoff mode. ([provider notes](https://docs.runmaestro.ai/advanced/provider-notes)) |
| Grok Code | `grok-code-1` | Provider key (`XAI_API_KEY`) | Higher reasoning mode. ([provider notes](https://docs.runmaestro.ai/advanced/provider-notes)) |
| OpenCode / Crush / Amp | Mode-specific | Mixed (optional/none by mode) | Check mode-specific requirements in provider notes + config. ([provider notes](https://docs.runmaestro.ai/advanced/provider-notes), [mode config](https://github.com/RunMaestro/Maestro/blob/main/src/shared/mode-config.ts)) |

---

## Pricing

| Plan | Price | Notes |
|------|-------|-------|
| Desktop app | Free | OSS desktop app (AGPL-3.0), downloadable releases. ([GitHub repo](https://github.com/RunMaestro/Maestro)) |
| Support / sponsorship | Optional | Users can sponsor development via GitHub sponsorship links. ([GitHub repo](https://github.com/RunMaestro/Maestro)) |

Pricing controversy/backlash is limited because Maestro is currently free/open-source. One community thread asks for optional paid features/freemium structure, indicating monetization is still evolving rather than broadly contentious today. ([Issue #856](https://github.com/RunMaestro/Maestro/issues/856))

## Community Sentiment

### What people love
- “Multi-agent setup with Claude/GPT/Ollama is very cool.” ([HN item 45574532](https://news.ycombinator.com/item?id=45574532), [HN API mirror](https://hn.algolia.com/api/v1/items/45574532))
- Users highlight parallel workflows and branch safety; one HN comment frames it as strong for solo founders managing many simultaneous feature/fix branches. ([HN item 45574532](https://news.ycombinator.com/item?id=45574532), [HN API mirror](https://hn.algolia.com/api/v1/items/45574532))
- Open source + cross-platform support are recurrent positives in launch discussion and GitHub stars trajectory. ([GitHub repo](https://github.com/RunMaestro/Maestro))

### Top complaints
1. **Keyboard consistency gaps**: “Keyboard shortcuts should work regardless of tab currently active.” ([Issue #977](https://github.com/RunMaestro/Maestro/issues/977))
2. **Shortcut behavior regressions in creation flow**: “cmd+n should always open the new project dialog.” ([Issue #899](https://github.com/RunMaestro/Maestro/issues/899))
3. **Windows reliability issues for agent launch**: “Error launching claude code on Windows (spawn EINVAL).” ([Issue #961](https://github.com/RunMaestro/Maestro/issues/961))
4. **Session persistence/restore bugs**: “Saved sessions cannot be reopened upon app relaunch.” ([Issue #645](https://github.com/RunMaestro/Maestro/issues/645))
5. **Performance concerns under heavy logs/large files**: issue title calls out “memory leak and app lag.” ([Issue #869](https://github.com/RunMaestro/Maestro/issues/869))
6. **Missing integrated browser**: users explicitly request in-app browser support to reduce context switching. ([Issue #1218](https://github.com/RunMaestro/Maestro/issues/1218))

---

## Sources

### Official
- https://runmaestro.ai: Product website
- https://github.com/RunMaestro/Maestro: Repo, stars, license, release assets, core feature framing
- https://docs.runmaestro.ai/guides/quick-start: Setup and product usage baseline
- https://docs.runmaestro.ai/guides/worktree-integration: Worktree behavior and setup
- https://docs.runmaestro.ai/guides/keyboard-shortcuts: Official keyboard reference
- https://docs.runmaestro.ai/advanced/configuration: Mode args/env, integration config
- https://docs.runmaestro.ai/advanced/provider-notes: Mode/provider/BYOK and model notes
- https://docs.runmaestro.ai/advanced/remote-access: Local-first remote architecture via tunnel
- https://docs.runmaestro.ai/cli: CLI overview
- https://docs.runmaestro.ai/cli/mcp-server: MCP server capabilities and limits

### Community & Analysis
- https://news.ycombinator.com/item?id=45574532: Launch/community sentiment
- https://hn.algolia.com/api/v1/items/45574532: Structured comment mirror for quote verification

### Issues & Complaints
- https://github.com/RunMaestro/Maestro/issues/977: Shortcut scope inconsistency
- https://github.com/RunMaestro/Maestro/issues/899: `cmd+n` behavior issue
- https://github.com/RunMaestro/Maestro/issues/961: Windows spawn EINVAL issue
- https://github.com/RunMaestro/Maestro/issues/645: Session restore issue
- https://github.com/RunMaestro/Maestro/issues/869: Memory/performance issue
- https://github.com/RunMaestro/Maestro/issues/1218: Browser integration request
- https://github.com/RunMaestro/Maestro/issues/856: Freemium/pricing suggestion

### Security
- https://github.com/RunMaestro/Maestro/security: Security advisories page (no published advisories shown at evaluation time)
- https://github.com/RunMaestro/Maestro/blob/main/src/main/services/api-key-service.ts: API key storage via OS keychain (`keytar`)

### Press
- N/A (no major external press coverage used as primary evidence in this evaluation)

## Discrepancies with current table
- Resolved in this update: Maestro **MCP server** was changed from `✗` to `~` in `website/comparison.html` to reflect shipped (but limited) MCP server support. ([MCP server docs](https://docs.runmaestro.ai/cli/mcp-server))
