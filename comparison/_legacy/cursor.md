# Cursor

> Last evaluated: 2026-02-28
> Website: https://cursor.com
> GitHub: N/A (closed source, VS Code fork)
> Stars: N/A
> License: Proprietary
> ARR: $500M+ (2025), Valuation: $10B

## Summary

AI-powered code editor (VS Code fork) with inline editing, agent chat, parallel agents with git worktree isolation, background cloud agents, and embedded browser. The most feature-rich AI IDE on the market, but task management is not its focus — it's a code editor with AI agents, not a project management tool.

## Datapoint Evaluation

| Feature | Verdict | Notes |
|---------|---------|-------|
| Kanban board | ✗ | No built-in kanban. Agent sidebar shows running agents but is session-scoped, not persistent task tracking. 3rd-party workarounds exist (Kaiban Board, Todo2, Kanban MCP). |
| Local-first | ✓ | Code on disk, chat in local SQLite (`state.vscdb`). AI requests route through Cursor cloud. Codebase indexing uses Turbopuffer (cloud vector store). No offline AI. |
| MCP server | ✗ | MCP *client* only — connects to external MCP servers (stdio, SSE, HTTP). Does not expose its own MCP server. Feature request exists but was closed with no response. |
| Keyboard-driven | ✓ | Inherits VS Code's full shortcut system. AI shortcuts: Cmd+K (inline edit), Cmd+L (chat), Cmd+I (composer). Vim via extension (not native). Agent sidebar keyboard nav is limited. |
| Terminal | ~ | VS Code's integrated terminal — global, not per-task. Cloud Agents get isolated VM terminals. Agent can auto-execute commands with sandboxing (seatbelt/Landlock). |
| Embedded browser | ~ | Added in 1.7 (beta), GA in 2.0. Implemented as internal MCP server. Agent can navigate, click, screenshot, inspect console/network. Workspace-scoped, not per-task. No mobile emulation. |
| Code editor | ✓ | Full VS Code editor with Tab completion (proprietary Fusion model), Cmd+K inline edit, multi-file agent editing. Parallel agents open separate windows per worktree. |
| Git worktree isolation | ✓ | Cursor 2.0 headline feature. Auto-creates worktrees for parallel agents (up to 8). Stored at `~/.cursor/worktrees/`. Background agents clone to separate VMs instead. No LSP in worktrees. |
| Multi-provider AI agents | ✓ | 5+ providers, 25+ models. BYOK for OpenAI, Anthropic, Google, Azure, Bedrock, OpenAI-compatible. **But**: BYOK only works in Chat/Ask mode — Agent and Edit modes require Cursor's proprietary models. |

---

## Detailed Feature Analysis

### Kanban / Task Management

Cursor has **no built-in kanban, backlog, or persistent task management**. There is no "projects" or "tasks" concept — it's fundamentally a code editor with AI agents.

**Plan Mode** (added ~1.2, refined in 2.0) lets the agent break a prompt into structured steps that appear inline in chat. Plans can be saved as markdown. However, these are ephemeral — they live within a single agent conversation, not as persistent project-level artifacts. Planning docs note that "planning and to-dos are currently not supported for auto mode." ([cursor.com/docs/agent/planning](https://cursor.com/docs/agent/planning))

**Cursor 2.0 Agent Sidebar** redesigned the UI with an "Agent" vs "Editor" mode toggle. The sidebar shows active agents, context pills, real-time progress (e.g., "searching codebase"), and agent plans. Up to 8 parallel agents visible. But this is a **session-scoped view** — no persistent backlog, priority columns, or cross-session tracking. The agent/editor mode switch has been polarizing: "shifted the whole menu, which breaks muscle memory" ([forum](https://forum.cursor.com/t/cursor-2-0-is-there-way-to-hide-or-move-the-agent-editor-switch-on-the-top-left/140035)).

**Cloud Agents Dashboard** at `cursor.com/agents` (also `Cmd+B`) shows a list view of background agents with status (CREATING/RUNNING/FINISHED), created time, branch, and PR URL. API at `GET /v0/agents`. This is the closest to a "task dashboard" but only tracks AI agent runs, not human-defined tasks.

**3rd-party workarounds:**
- **Kaiban Board** ([kaibanboard.com](https://kaibanboard.com)): Free MIT extension reading `.agent/TASKS/` markdown files with frontmatter. Drag-and-drop kanban with Backlog/To Do/Doing/Testing/Done columns.
- **Vibe Kanban** ([vibekanban.com](https://vibekanban.com/docs/integrations/vscode-extension)): Cross-IDE extension with Logs/Diffs/Processes views, task-specific worktrees. Featured on [HN](https://news.ycombinator.com/item?id=44533004).
- **Todo2**: Marketplace extension with AI-powered project manager and kanban.
- **Cursor Project Master** ([github](https://github.com/heyzgj/cursor-project-master)): Converts project doc into kanban, feeds Cursor one task at a time.
- **kanban-mcp** ([github](https://github.com/bradrisse/kanban-mcp)), **claude-task-master** ([github](https://github.com/eyaltoledano/claude-task-master)): MCP servers adding kanban functionality.

Forum requests with significant engagement: [Kanban view for agents](https://forum.cursor.com/t/kanban-view-for-agents/149412), [Projects folder with todo list](https://forum.cursor.com/t/projects-folder-with-todo-list-tied-to-agent/152197), [Backlog/kanban board](https://forum.cursor.com/t/backlog-kanban-board-in-cursor/132471).

---

### Local-First Architecture

**Local storage:** Chat data in SQLite `state.vscdb` using `ItemTable` (key-value). Two instances: `globalStorage/state.vscdb` (app-wide) and `workspaceStorage/<hash>/state.vscdb` (per-workspace conversations). Keys: `composer.composerData`, `workbench.panel.aichat.view.aichat.chatdata`. Also stores security settings: `useYoloMode`, `yoloCommandAllowlist`, `mcpAllowedTools`. Paths: macOS `~/Library/Application Support/Cursor/User/`, Linux `~/.config/Cursor/User/`. ([source](https://dasarpai.com/dsblog/cursor-chat-architecture-data-flow-storage/))

**Security concern:** Databases are **plain-text SQLite with no encryption**. Any local process can read chat history. Users reported "corporate scripts deployed to monitor AI interaction data." SQLCipher encryption requested but not implemented. ([forum](https://forum.cursor.com/t/privacy-leakage-encrypt-local-sqlite-databases-to-prevent-unauthorized-telemetry-and-resource-contention/149469))

**What goes to the cloud:**
1. Codebase indexing: Merkle tree hash comparison → changed files chunked via tree-sitter AST → sent to Cursor servers → embedded → stored in **Turbopuffer** (serverless vector DB on Google Cloud). Only embeddings stored, not source code. File paths obfuscated with client-side encryption. ([source](https://read.engineerscodex.com/p/how-cursor-indexes-codebases-fast))
2. All AI requests route through Cursor's AWS infrastructure, even with BYOK keys
3. Cloud Agents run on isolated Ubuntu VMs, repo cloned from GitHub

**Offline:** Editor works (read/write, syntax, git, tests). All AI breaks: chat, agent, completions, codebase search. Even local LLMs via Ollama don't fully work because "Cursor still relies on its own backend for prompt processing." ([forum](https://forum.cursor.com/t/offline-use-possible/704))

**Privacy tiers:**
- **Default**: Code sent through Cursor → LLM providers. Providers may retain data.
- **Privacy Mode** (default for 50%+ users): Zero-data-retention agreements with providers. Code not stored for training. Background Agents and Memories still work (Cursor may store "some code data to provide features").
- **Ghost Mode**: Zero data leaves local machine. Code routes directly to LLM provider. Breaks: Cloud Agents, memory sync, team sharing, Bugbot.

**No local indexing option.** Can disable indexing entirely or exclude via `.cursorignore`, but no local-only embedding pipeline. ([forum](https://forum.cursor.com/t/indexing-locally/17124))

---

### MCP Support

**MCP client** documented at [cursor.com/docs/context/mcp](https://cursor.com/docs/context/mcp). Agent auto-discovers relevant MCP tools. Up to **40 tools** across all servers. Default requires approval; auto-approve/yolo configurable.

**Transport types:** stdio, SSE, HTTP/HTTPS, streamable-http.

**Config:** Global at `~/.cursor/mcp.json`, project at `.cursor/mcp.json`. Project > global > nested (parent dirs searched). Windows project-level config has [reported issues](https://forum.cursor.com/t/project-level-mcp-json-configuration-not-working-in-windows11/62182).

**OAuth:** 40+ servers support OAuth (Slack, Notion, Linear, Sentry, Supabase, Vercel, etc.).

**One-click gallery** with "Add to Cursor" buttons. Developers can add install buttons to their own docs.

**CLI MCP:** Full support — `agent mcp list`, `agent mcp list-tools`, `agent mcp login`, `agent mcp enable/disable`. Config shared between CLI and editor.

**Not an MCP server.** Feature request at [forum](https://forum.cursor.com/t/cursor-as-mcp-server/95711) auto-closed after 30 days, no official response.

**Built-in browser = internal MCP server.** The browser panel is itself an MCP server the agent consumes. Tools: visit URLs, click, fill forms, scroll, screenshot, read console, monitor network traffic.

**Only tools, no resources.** MCP resource support not yet available.

---

### Keyboard-Driven

**Cursor-specific shortcuts** (beyond VS Code defaults, from [docs](https://cursor.com/docs/configuration/kbd)):
- `Cmd I` / `Cmd L`: Toggle sidepanel
- `Cmd E`: Toggle Agent layout
- `Cmd .`: Mode menu (Agent/Ask/Plan/Debug)
- `Cmd /`: Cycle AI models
- `Cmd K`: Inline edit
- `Cmd Shift K`: Toggle input focus
- `Cmd Shift J`: Cursor settings
- `Cmd Shift Space`: Voice Mode
- `Tab`: Cycle to next message
- `Shift Tab`: Rotate Agent modes
- `Cmd N` / `Cmd R`: New chat
- `Cmd T`: New chat tab
- `Cmd [` / `Cmd ]`: Previous/next chat

**Vim:** Supported via VSCode Vim or VSCode Neovim extension. Known conflicts: Ctrl+K clashes with Vim bindings, navigation keys (ijkl) broke in Explorer after 2.2.14 update ([forum](https://forum.cursor.com/t/vim-extension-navigation-keys-ijkl-not-working-in-explorer-after-cursor-2-2-14-update/145878)), multi-cursor glitches, text types into editor instead of agent chat ([forum](https://forum.cursor.com/t/changing-tool-commands-in-vim-mode-types-in-editor/55129)). One user spent [6 months](https://dredyson.com/my-6-month-quest-to-integrate-cursor-with-neovim-practical-solutions-and-painful-lessons/) trying to integrate Cursor with Neovim.

**Agent sidebar keyboard nav is limited.** No direct shortcut to switch editor↔agent views ([forum](https://forum.cursor.com/t/any-shortcut-to-switch-from-editor-to-agent-view/146598)). Layout cycling requires `Opt+Cmd+Tab` multiple times. Feature request for direct layout shortcuts got [2 upvotes, zero replies](https://forum.cursor.com/t/keyboard-shortcut-for-a-specific-agent-layout/147387).

Cursor is fundamentally a **mouse-first GUI** with keyboard shortcuts layered on. No vim-style navigation for agents/tasks, no keyboard-navigable kanban, no compositional keyboard language.

---

### Terminal

**Base:** VS Code integrated terminal with AI agent orchestration. Since Cursor 1.3, agents use the developer's native terminal directly — "A new terminal will be created when needed and runs in the background." Terminal persists command history across sessions. User can see agent commands in real time and manually intervene. ([changelog](https://cursor.com/changelog/1-3))

**Sandboxing** (GA in Cursor 2.0, [blog](https://cursor.com/blog/agent-sandboxing)):
- **macOS**: `sandbox-exec` (Apple's seatbelt, deprecated 2016 but still used by Chrome). Dynamic policy restricts writes to protected dirs (.vscode, .cursor, .git/config, .git/hooks). Blocks network by default.
- **Linux**: Landlock v3 (kernel 6.2+) + seccomp + user namespaces. Overlay filesystem for ignored files.
- **Windows**: Linux sandbox inside WSL2.
- **Network**: Default blocklist for private IPs (10.x, 172.16.x, 192.168.x, 127.x) and cloud metadata. Default allowlist for npm, PyPI, Cargo, AWS, GCP, Azure. Customizable via `sandbox.json`.
- Result: Sandboxed agents "stop 40% less often" because more operations auto-approved.

**Auto-run modes:**
1. **Run in Sandbox** (default): Auto-execute within sandbox. On failure: Skip/Run/Add to allowlist.
2. **Ask Every Time**: Manual approval for every command.
3. **Run Everything** (YOLO): No confirmation. Configurable allow/deny lists. Community reports YOLO sometimes still prompts. ([forum](https://forum.cursor.com/t/how-to-enable-actual-yolo-auto-run-mode/67491))

**Cloud Agent terminals:** Fresh Ubuntu VM per task. Own filesystem, shell, network stack. All commands auto-execute. `environment.json` configures background processes (e.g., `npm run watch`) in tmux. ([docs](https://www.digitalapplied.com/blog/cursor-cloud-agents-isolated-vms-guide))

**Not per-task.** Local terminal is shared/global. Parallel agents in separate worktree windows get separate terminals. Cloud agents get isolated VM terminals.

---

### Embedded Browser

**Timeline:**
- **Cursor 1.7** (Sep 29, 2025): Browser beta. ([forum](https://forum.cursor.com/t/cursor-1-7-is-here/135333))
- **Cursor 2.0** (Oct 29, 2025): Browser GA. DOM element selection forwarding to agents. ([changelog](https://cursor.com/changelog/2-0))
- **Cursor 2.2** (Dec 10, 2025): Visual Editor — real-time CSS manipulation sidebar, component tree. ([blog](https://cursor.com/blog/browser-visual-editor))
- **Cursor 2.3** (Dec 22, 2025): Multiple browser tabs. ([changelog](https://cursor.com/changelog/2-3))
- **Cursor 2.4** (Jan 22, 2026): 10x faster navigation, drag-and-drop, improved text input.

**Implementation:** Internal MCP server extension running in Electron's Chromium engine via WebContentsView. Two options: embedded Browser Tab (in editor pane) and standalone Chrome launch. Embedded tab has exclusive element-selection-to-context tool.

**Agent capabilities:** Navigate URLs, click/hover/right-click, fill forms, scroll, screenshot, read console messages/errors, monitor HTTP requests+responses+payloads, network traffic. Visual Editor adds real-time CSS manipulation.

**Limitations:**
- Workspace-scoped, not per-task
- No mobile viewport emulation (requested: [forum](https://forum.cursor.com/t/add-a-device-view-toggle-like-chrome-s-devtools-to-the-cursor-browser/140977), [forum](https://forum.cursor.com/t/change-to-mobile-tablet-desktop-in-browser/147441))
- Not identical to full Chrome — "Chromium-like, not identical to your daily Chrome build"
- Security: Per-session tokens, unique tab IDs, configurable tool approval, enterprise origin allowlists

---

### Code Editor

**What makes it different from VS Code:**
- **Tab completion** (Fusion model): Proprietary sparse LM predicting edits + navigation jumps. 260ms p50 latency, 13K token context, suggests 10x longer edits vs original model. "Over a billion edited characters per day." Requires Pro sub, cannot use with BYOK. ([blog](https://cursor.com/blog/tab-update))
- **Inline edit** (Cmd+K): Select code, describe change, get colored diff preview. Also supports quick questions (Opt+Return) and send-to-chat (Cmd+L). ([docs](https://cursor.com/docs/inline-edit/overview))
- **Agent mode** (Cmd+I): Autonomous multi-file editing. Searches codebase semantically, opens docs, modifies files, runs commands. Default mode since late Feb 2025.
- **Plan mode** (2.1): Research → plan with Mermaid diagrams → review → build on approval.
- **Debug mode** (2.2): Hypothesis generation, runtime log instrumentation, analysis.

**Parallel agent file conflicts:** Each agent works in isolated worktree = no conflicts during dev. Conflicts arise at merge. Forum reports incorrect merge resolution: "all first changes were reverted and second change was applied." ([forum](https://forum.cursor.com/t/wrong-merge-conflicts-possibly-only-in-multi-agent/146203)) Subfolder-opened repos also fail to merge properly. ([forum](https://forum.cursor.com/t/parallel-agents-do-not-properly-merge-back-changes-when-working-on-subfolders-of-git-repo/150279))

**Multi-Agent Judging** (2.2): Auto-evaluates parallel agent results, recommends best solution.

**Diff review:** Floating review bar, file-by-file navigation, per-hunk accept/reject. But: inline buttons sometimes unresponsive in certain file types, agent reportedly auto-accepts its own changes during multi-edits. ([forum](https://forum.cursor.com/t/accept-reject-changes-and-diff-doesnt-show-on-edit-v2-4-23/150367))

---

### Git Worktree Isolation

**How it works:** Automatic 1:1 agent-to-worktree mapping. Selecting worktree option from agent dropdown → `git worktree add` under the hood → new branch + copies modified/new files (excluding gitignored). ([docs](https://cursor.com/docs/configuration/worktrees))

**Storage:** `~/.cursor/worktrees/<repo>/`. Up to 20 worktrees per workspace before auto-cleanup (default: 6hr inactivity, oldest first).

**Capacity:** Up to 8 parallel local agents. ([changelog](https://cursor.com/changelog/2-0))

**Merging back:** Two approaches:
1. Full Overwrite: Replace entire file with worktree version
2. Native Merge: Cursor's conflict resolution UI

Known issues: Incorrect merge resolution ([forum](https://forum.cursor.com/t/wrong-merge-conflicts-possibly-only-in-multi-agent/146203)), subfolder failures ([forum](https://forum.cursor.com/t/parallel-agents-do-not-properly-merge-back-changes-when-working-on-subfolders-of-git-repo/150279)).

**worktrees.json:** `.cursor/worktrees.json` for custom init scripts (OS-specific `setup-worktree-unix`/`setup-worktree-windows`). Community pattern: atomic task claiming via lock directories for agent IDs 1-8. ([forum guide](https://forum.cursor.com/t/cursor-2-0-split-tasks-using-parallel-agents-automatically-in-one-chat-how-to-setup-worktree-json/140218))

**LSP limitation:** Language server unsupported in worktrees for performance reasons. Agents don't get real-time type checking or lint errors. ([docs](https://cursor.com/docs/configuration/worktrees))

**Cloud Agents:** Don't use local worktrees. Clone repo into isolated Ubuntu VM, work on separate branch, auto-create PR. "30%+ of internal PRs created by agents in cloud sandboxes." ([blog](https://cursor.com/blog/agent-computer-use))

---

### Multi-Provider AI Agents

**Models** (from [docs](https://cursor.com/docs/models)):

| Provider | Models |
|----------|--------|
| Anthropic | Claude 4 Sonnet, Claude 4 Sonnet 1M, Claude 4.5 Haiku, Claude 4.5 Opus, Claude 4.5 Sonnet, Claude 4.6 Opus, Claude 4.6 Opus Fast, Claude 4.6 Sonnet |
| OpenAI | GPT-5, GPT-5 Fast, GPT-5 Mini, GPT-5-Codex, GPT-5.1 Codex, GPT-5.1 Codex Max, GPT-5.1 Codex Mini, GPT-5.2, GPT-5.2 Codex, GPT-5.3 Codex |
| Google | Gemini 2.5 Flash, Gemini 3 Flash, Gemini 3 Pro, Gemini 3 Pro Image Preview, Gemini 3.1 Pro |
| xAI | Grok Code |
| Moonshot | Kimi K2.5 |
| Cursor | Composer 1, Composer 1.5 (proprietary) |

**BYOK:** OpenAI, Anthropic, Google, Azure, Bedrock, OpenAI-compatible (OpenRouter, Ollama, Groq). Configured in Settings > Models > API Keys. ([docs](https://cursor.com/docs/settings/api-keys))

**Critical BYOK limitation:** Agent mode and Edit mode (Cmd+K) **do NOT work with BYOK**. Error: "Agent and Edit rely on custom models that cannot be billed to an API key." Reasons: proprietary LoRA adapters, optimized infrastructure with extended context, and business model (Agent/Edit justify $20/mo Pro). BYOK only works in Chat/Ask mode. Tab completion also requires Pro (uses Fusion model). ([source](https://apidog.com/blog/cursor-byok-ban-alternative/), [forum](https://forum.cursor.com/t/agent-mode-in-byok/147497))

**All BYOK requests route through Cursor's servers.** Key sent with each request, backend constructs full prompt with codebase context before forwarding. ([source](https://apidog.com/blog/cursor-byok-ban-alternative/))

**Local models (Ollama):** Possible via OpenAI-compatible API + ngrok tunnel (Cursor backend needs to reach endpoint). Limited to Chat/Ask only. ([guide](https://themeansquare.medium.com/running-local-ai-models-in-cursor-the-complete-guide-4290fe0383fa))

**Cloud Agent models:** Restricted to Max Mode-compatible models only (premium tier: claude-4.5-opus-high-thinking, gpt-5.2, gemini-3-pro, etc.). Cannot select lighter models. ([forum](https://forum.cursor.com/t/cloud-agent-more-default-options-for-cursor/149950))

---

## Pricing

| Plan | Price | Key limits |
|------|-------|------------|
| Hobby | Free | Limited agent requests + tab completions |
| Pro | $20/mo | $20 in API credits (usage-based since Jun 2025) |
| Pro+ | $60/mo | 3x credits |
| Ultra | $200/mo | 20x credits |
| Teams | $40/user/mo | SSO, RBAC, shared chats, analytics |
| Enterprise | Custom | SCIM, audit logs, pooled credits |
| BugBot | Free/$40/user/mo | Automated PR review add-on |

**Pricing controversy (Jun 2025):** Replaced 500 fast requests/month with usage-based $20 credits. Claude Opus costs burned through credits in hours. CEO Truell issued public apology and offered refunds. One team's $7,000 annual sub depleted in a day. A $60 Pro+ user exhausted quota in <24 hours. ([TechCrunch](https://techcrunch.com/2025/07/07/cursor-apologizes-for-unclear-pricing-changes-that-upset-users/), [Monetizely](https://www.getmonetizely.com/blogs/cursor-ais-billion-dollar-saas-pricing-fiasco))

---

## Community Sentiment

### What people love
- Tab completion with whole-project awareness
- Multi-file agent refactors
- Rapid feature velocity (2.0 → 2.4 in 4 months)
- $500M+ ARR proves massive adoption

### Top complaints (by frequency)
1. **Pricing opacity & surprise charges** — dominant issue across all platforms
2. **Performance** — memory leaks (64GB drained in 1hr, 10GB+ single instances), CPU spikes, 2-3 restarts/day needed. ([forum](https://forum.cursor.com/t/cursor-consuming-massive-amounts-of-memory-and-compute/17171))
3. **AI quality inconsistency** — brilliant one moment, hallucinating the next
4. **Customer support** — AI support bot fabricated policies (Apr 2025 incident), ghosted refunds, deleted Reddit criticism. ([HN](https://news.ycombinator.com/item?id=43683012))
5. **Security** — CVE-2025-54135/54136 (MCPoison: MCP config swap → RCE), Rules File Backdoor (hidden unicode in .cursorrules), CVE-2025-59944 (case-sensitivity → RCE). ([Check Point](https://research.checkpoint.com/2025/cursor-vulnerability-mcpoison/))
6. **Privacy** — Privacy Mode OFF by default on Free/Pro. Telemetry can't be disabled on company plans. Code routes through 8 subprocessors.
7. **Context window** — advertised 200K, usable 70-120K after internal truncation
8. **Large codebase issues** — 7-12hr indexing on C/C++ repos with 8800+ files
9. **Breaking updates** — no rollback mechanism, sparse changelogs
10. **Growing competition** — Claude Code + VS Code multi-agent eroding differentiation

> "Too many updates that disturb my workflow, no easy way to roll back versions, super sparse changelogs, lots of magic in context building, really untransparent pricing on max mode." — [HN user who switched to Claude Code](https://news.ycombinator.com/item?id=44185572)

---

## Sources

### Official
- https://cursor.com/features: Features overview
- https://cursor.com/pricing: Pricing tiers
- https://cursor.com/security: Privacy/Ghost Mode, data handling
- https://cursor.com/docs/models: Full model list
- https://cursor.com/docs/context/mcp: MCP client support
- https://cursor.com/docs/settings/api-keys: BYOK support
- https://cursor.com/docs/agent/terminal: Terminal sandboxing
- https://cursor.com/docs/agent/browser: Embedded browser
- https://cursor.com/docs/agent/planning: Plan mode
- https://cursor.com/docs/agent/modes: Agent/Ask/Plan/Debug modes
- https://cursor.com/docs/agent/review: Diff review system
- https://cursor.com/docs/inline-edit/overview: Inline edit (Cmd+K)
- https://cursor.com/docs/configuration/worktrees: Parallel agents + worktrees
- https://cursor.com/docs/configuration/kbd: Keyboard shortcuts
- https://cursor.com/docs/cli/overview: CLI documentation
- https://cursor.com/docs/cli/mcp: CLI MCP support
- https://cursor.com/changelog/1-3: Shared terminal launch
- https://cursor.com/changelog/2-0: Cursor 2.0 (parallel agents, browser GA, sandbox GA)
- https://cursor.com/changelog/2-2: Multi-Agent Judging, Debug mode, Visual Editor
- https://cursor.com/changelog/2-3: Multi-tab browser
- https://cursor.com/blog/tab-update: Fusion model for Tab completion
- https://cursor.com/blog/agent-sandboxing: Sandbox architecture (seatbelt/Landlock)
- https://cursor.com/blog/browser-visual-editor: Visual Editor
- https://cursor.com/blog/agent-computer-use: Cloud agents with computer use
- https://cursor.com/blog/cloud-agents: Cloud agents launch

### Community & Analysis
- https://dasarpai.com/dsblog/cursor-chat-architecture-data-flow-storage/: SQLite storage architecture
- https://read.engineerscodex.com/p/how-cursor-indexes-codebases-fast: Turbopuffer indexing pipeline
- https://tarq.net/posts/cursor-sqlite-command-allowlist/: state.vscdb reverse engineering
- https://apidog.com/blog/cursor-byok-ban-alternative/: BYOK limitations analysis
- https://dev.to/arifszn/git-worktrees-the-power-behind-cursors-parallel-agents-19j1: Worktree internals

### Forum Feature Requests
- https://forum.cursor.com/t/kanban-view-for-agents/149412: Kanban request
- https://forum.cursor.com/t/projects-folder-with-todo-list-tied-to-agent/152197: Projects + todo request
- https://forum.cursor.com/t/cursor-as-mcp-server/95711: MCP server request (closed, no response)
- https://forum.cursor.com/t/add-a-device-view-toggle-like-chrome-s-devtools-to-the-cursor-browser/140977: Mobile viewport request
- https://forum.cursor.com/t/keyboard-shortcut-for-a-specific-agent-layout/147387: Layout shortcuts request

### Issues & Complaints
- https://forum.cursor.com/t/wrong-merge-conflicts-possibly-only-in-multi-agent/146203: Merge conflicts
- https://forum.cursor.com/t/cursor-consuming-massive-amounts-of-memory-and-compute/17171: Memory issues
- https://forum.cursor.com/t/privacy-leakage-encrypt-local-sqlite-databases-to-prevent-unauthorized-telemetry-and-resource-contention/149469: Unencrypted SQLite
- https://forum.cursor.com/t/agent-mode-in-byok/147497: BYOK frustration

### Security
- https://research.checkpoint.com/2025/cursor-vulnerability-mcpoison/: MCPoison CVE
- https://thehackernews.com/2025/03/new-rules-file-backdoor-attack-lets.html: Rules file backdoor
- https://www.lakera.ai/blog/cursor-vulnerability-cve-2025-59944: Case-sensitivity RCE

### Press
- https://techcrunch.com/2025/07/07/cursor-apologizes-for-unclear-pricing-changes-that-upset-users/: Pricing apology
- https://www.getmonetizely.com/blogs/cursor-ais-billion-dollar-saas-pricing-fiasco: Pricing analysis

## Discrepancies with current table
- None — table is up to date
