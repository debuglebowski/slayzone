# Linear

> Last evaluated: 2026-02-28
> Website: https://linear.app
> GitHub: https://github.com/linear/linear (SDK + integrations only; app is closed-source)
> Stars: N/A (closed-source)
> License: Proprietary (cloud SaaS only)

## Summary

Modern, keyboard-driven project management for software teams. Famous for its local-first sync engine (IndexedDB + WebSocket delta sync), sub-200ms interactions, and developer-centric UX. Positions itself as an agent orchestration layer — AI agents (Cursor, Codex, Devin) are first-class workspace members, but Linear itself has no terminal, code editor, browser, or worktree features. It is a planning/tracking tool, not a development environment.

## Datapoint Evaluation

| Feature | Verdict | Notes |
|---------|---------|-------|
| Kanban board | ✓ | Full board view with drag-and-drop, swimlanes, column hiding. No WIP limits. |
| Local-first | ✗ | Client-side IndexedDB cache + offline editing, but server-authoritative cloud storage (GCP Postgres). Requires account. |
| MCP server | ✓ | Official remote MCP server with 22+ tools. SSE + Streamable HTTP transports. OAuth 2.1 auth. |
| Keyboard-driven | ✓ | Industry-leading shortcuts. 100+ keybindings, chord navigation (G I, M B), Cmd+K command palette. No vim mode. |
| Terminal | ✗ | No terminal. Third-party CLIs exist (linear-cli, linearis) but no built-in shell. |
| Embedded browser | ✗ | No embedded browser. Figma/Loom links auto-embed as previews but no arbitrary URL browsing. |
| Code editor | ✗ | Rich-text Markdown editor for issue descriptions only. No code editor, no LSP, no diff review. |
| Git worktree isolation | ✗ | Generates branch names (Cmd+Shift+.) but no worktree creation, management, or awareness. |
| Multi-provider AI agents | ✗ | Orchestration layer — assigns issues TO external agents (Cursor, Codex, Devin). Does not run agents itself. No BYOK. |

---

## Detailed Feature Analysis

### Kanban / Task Management

Linear's board view is one of two primary layouts (board and list), toggled via `Cmd+B`. The board defaults to grouping by Status with columns like Backlog, Todo, In Progress, Done, Canceled. Columns can be grouped by Focus, Project, Priority, Cycle, Label, Label group, or SLA status. Columns can be hidden, and issues can be dragged into hidden columns. Swimlanes were added as a secondary grouping dimension — rows by teams, cycles, assignee, lead, initiative, or project health, each collapsible. Source: [Board Layout docs](https://linear.app/docs/board-layout).

Linear does **not** support WIP (Work In Progress) limits on columns. There is no mechanism to cap issue count in a status. This is a meaningful gap vs. dedicated kanban tools. Board and list views share ordering and cannot differ, and board view is unavailable in split views like Inbox or Triage. Issue descriptions don't display on board cards. Source: [Board Layout docs](https://linear.app/docs/board-layout).

The organizational hierarchy is: Workspace > Teams (with sub-teams) > Issues (with sub-issues). Overlaid are: **Cycles** (time-boxed sprints, 1-2 weeks, auto-rollover), **Projects** (cross-team, goal-oriented, with milestones), and **Initiatives** (strategic groupings of projects). Sub-initiatives nest up to 5 levels deep (Enterprise only, added July 2025). Sub-issues support parent/child relationships with auto-close automations. Templates include standard templates (preset properties + description scaffolding) and form templates (Nov 2025 — structured fields: text, dropdown, checkbox, date). Project templates create projects with predefined issues and milestones. Source: [Conceptual Model](https://linear.app/docs/conceptual-model), [Initiatives](https://linear.app/docs/initiatives), [Form templates](https://linear.app/changelog/2025-11-20-form-templates).

Linear does **not** support truly arbitrary custom fields (user-defined number, formula, or dropdown fields on all issues). Its philosophy is opinionated simplicity over infinite configurability. Compared to Jira (WIP limits, JQL swimlanes, unlimited custom fields, complex workflows with transitions), Linear trades power for speed and clean defaults. Source: [Medium: Linear vs Jira](https://medium.com/@kamal.indika.n/linear-vs-jira-in-2025-practical-guide-for-modern-teams-c62aba67518e).

### Local-First Architecture

Linear's sync engine is the company's most important architectural component, built by CTO Tuomas Artman. The model: every user interaction writes to a **local IndexedDB database first**, and the UI updates instantly from local state. The server is "just another client to sync with." This eliminates network latency from the interaction path. Source: [Bytemash](https://bytemash.net/posts/i-went-down-the-linear-rabbit-hole/), [Scaling the Linear Sync Engine](https://linear.app/now/scaling-the-linear-sync-engine).

**Sync protocol** (reverse-engineered by [Wenzhao Hu](https://github.com/wzhudev/reverse-linear-sync-engine), endorsed by Artman): Full bootstrap via `/sync/bootstrap?type=full` returns 40+ model types as `ModelName=<JSON>` lines with a `lastSyncId`. Partial bootstrap fetches heavier data (comments, history). WebSocket connection pushes `SyncAction` objects with `action` types (Insert/Update/Delete/Archive). Delta sync via `/sync/delta` with lastSyncId/toSyncId catches up after offline periods. Writes go through GraphQL mutations, not the sync channel. Source: [Reverse Engineering Linear's Sync Engine](https://github.com/wzhudev/reverse-linear-sync-engine), [Mark Not Found](https://marknotfound.com/posts/reverse-engineering-linears-sync-magic/).

**Reactive layer**: MobX observable boxes with `Object.defineProperty` getters/setters. Sync actions update model properties, MobX auto-triggers React re-renders. Models use TypeScript decorators with load strategies: instant, lazy, partial, explicitlyRequested, local (IndexedDB-only). Source: [Reverse Engineering Linear's Sync Engine](https://github.com/wzhudev/reverse-linear-sync-engine).

**Offline**: Transactions cache locally in IndexedDB and auto-resend on reconnect. Can create/edit issues offline. Uses OT (Operational Transform) for rich-text and last-write-wins for structured properties. However, this is **not** local-first in the academic sense (Kleppmann et al.). The server remains the single source of truth. Clients need it for auth, bootstrap, and conflict resolution. Can't operate indefinitely without server. A more accurate description is "local-first sync with server authority." Source: [Bytemash](https://bytemash.net/posts/i-went-down-the-linear-rabbit-hole/).

**Infrastructure**: Runs on Google Cloud Platform with Kubernetes. Primary DB is Cloud SQL for PostgreSQL (scaled to tens of terabytes). Redis (Memorystore) for event bus/cache. MongoDB for caching. Source: [Google Cloud Blog](https://cloud.google.com/blog/products/databases/product-workflow-tool-linear-uses-google-cloud-databases).

**Privacy**: TLS 1.2 in-transit, AES 256-bit at-rest. SOC 2 Type II (since Oct 2021). GDPR compliant with DPA. HIPAA with BAA on Enterprise. Data residency: US or EU (chosen at workspace creation, permanent). Some metadata always stored in US. No self-hosted option. CSV and GraphQL API export. Source: [Linear Security](https://linear.app/features/secure), [Linear Security Docs](https://linear.app/docs/security), [Export docs](https://linear.app/docs/exporting-data).

**Why ✗ for SlayZone's "Local-first" column**: The tooltip specifies "All data stored on your machine. Works offline, no account required." Linear fails on "all data on your machine" (cloud-stored, locally cached) and "no account required" (requires Linear account). The sync engine is impressive but doesn't meet this definition.

### MCP Support

Linear has an **official, centrally-hosted remote MCP server** launched May 2025, expanded February 2026. Two transports: **SSE** at `https://mcp.linear.app/sse` and **Streamable HTTP** at `https://mcp.linear.app/mcp` (recommended). Auth via OAuth 2.1 with dynamic client registration, or direct `Authorization: Bearer <token>` header (OAuth tokens and restricted API keys, including read-only). Source: [MCP docs](https://linear.app/docs/mcp), [MCP launch](https://linear.app/changelog/2025-05-01-mcp).

**22+ tools exposed** (as of Feb 2026): `list_comments`, `create_comment`, `get_document`, `list_documents`, `get_issue`, `get_issue_git_branch_name`, `list_issues`, `create_issue`, `update_issue`, `list_issue_statuses`, `get_issue_status`, `list_my_issues`, `list_issue_labels`, `list_projects`, `get_project`, `create_project`, `update_project`, `list_teams`, `get_team`, `list_users`, `get_user`, `search_documentation`. Feb 2026 expansion added initiative CRUD, project milestones, project updates, labels, images. Source: [MCP PM expansion](https://linear.app/changelog/2026-02-05-linear-mcp-for-product-management).

**Client configuration**:
- Claude Code: `claude mcp add --transport sse linear-server https://mcp.linear.app/sse`
- Claude Desktop: JSON config with `npx -y mcp-remote https://mcp.linear.app/sse`
- Cursor: Deep link or MCP directory
- VS Code: Command palette + JSON with mcp-remote

The server is **not open-source** — hosted by Linear. Known issues: internal server errors (fix: clear `~/.mcp-auth`), WSL requires `--transport sse-only`. The deprecated [jerhadf/linear-mcp-server](https://github.com/jerhadf/linear-mcp-server) was a local stdio alternative. Other third-party options: [tacticlaunch/mcp-linear](https://github.com/tacticlaunch/mcp-linear), [geropl/linear-mcp-go](https://github.com/geropl/linear-mcp-go). Source: [MCP docs](https://linear.app/docs/mcp).

**Comparison to SlayZone**: SlayZone's MCP server exposes task context so agents running INSIDE the app can read/update task state. Linear's MCP server exposes project management data so EXTERNAL agents can integrate. Different use cases — Linear is the task tracker that agents query; SlayZone is the environment where agents run.

### Keyboard-Driven

Linear is widely regarded as having the best keyboard-driven interface in any PM tool. Single-letter and chord shortcuts (no modifier keys for most actions). Complete reference:

**General**: `Cmd+K` command menu, `Cmd+Enter` save, `Esc` back, `Space` peek (hold), `Enter`/`O` open, `X` select, `J`/`K` navigate, `Cmd+I` sidebar, `Cmd+B` toggle board/list, `F` filter, `?` help.

**Navigation chords**: `G I` inbox, `G M` my issues, `G T` triage, `G A` active, `G B` backlog, `G X` archived, `G E` all issues, `G C` cycles, `G V` current cycle, `G P` projects, `G S` settings. `O F` open favorite, `O P` open project, `O C` open cycle, `O U` open user, `O T` open team.

**Issue actions**: `C` new issue, `Alt+C` from template, `V` new fullscreen, `A` assign, `I` assign to me, `L` labels, `S` status, `P` priority, `Shift+E` estimate, `Shift+D` due date, `R` rename, `Cmd+Alt+1-9` set status, `Cmd+Shift+M` move to team, `Cmd+Delete` delete.

**Organization**: `Shift+C` add to cycle, `Shift+P` add to project, `Shift+M` milestone, `Cmd+Shift+P` parent. `M B` blocked, `M X` blocking, `M R` related, `M M` duplicate.

**Board movement**: `Alt+Shift+Up/Down` top/bottom, `Alt+Up/Down` one position, `Alt+Left/Right` columns.

**Copying**: `Cmd+.` issue ID, `Cmd+Shift+.` git branch name, `Cmd+Shift+,` URL.

Source: [ShortcutFoo cheatsheet](https://www.shortcutfoo.com/app/dojos/linear-app-mac/cheatsheet), [KeyCombiner](https://keycombiner.com/collections/linear/).

**No vim mode**. `J`/`K` mirrors vim's basic movement but no `h`/`l`, visual mode, `:` commands, or dot-repeat. A NeoVim plugin ([linear-nvim](https://github.com/rmanocha/linear-nvim)) exists for browsing from NeoVim.

**Keyboard gaps**: Drag-and-drop reordering beyond simple up/down, swimlane config, settings navigation, Figma embed interaction, some admin functions still require mouse. But day-to-day triage and development workflow is nearly 100% keyboard-operable.

### Terminal

Linear has **no built-in terminal or shell**. It is a web/desktop PM app. Third-party CLI tools exist:
- [linear-cli (schpet)](https://github.com/schpet/linear-cli): List, start, create PRs. Agent-friendly with AI skills.
- [Linearis](https://zottmann.org/2025/09/03/linearis-my-linear-cli-built.html): JSON output, smart ID resolution. Designed for LLM agents.
- [linear-cli (evangodon)](https://github.com/evangodon/linear-cli): Go-based CLI.
- [linear-4-terminal](https://github.com/nooesc/linear-4-terminal): Rust-based, full API coverage.

The MCP server can also be invoked from terminal-based AI agents (Claude Code). But Linear provides no PTY, no shell, no YOLO mode, no sandboxing, no auto-execute. Coding happens entirely outside Linear.

### Embedded Browser

Linear has **no embedded browser**. It supports **auto-embeds** for specific services — Figma links render as interactive design previews, YouTube/Loom/Descript links embed as inline players. General URLs can be attached via `Ctrl+L` but open in a new browser tab. There is no arbitrary URL browsing, no DevTools, no mobile emulation, no per-task web panel. Source: [Editor docs](https://linear.app/docs/editor), [Figma integration](https://linear.app/docs/figma).

### Code Editor

Linear has **no code editor**. Its rich-text editor handles issue descriptions, comments, and documents. It supports Markdown, code blocks with syntax highlighting (triple-backtick), Mermaid diagrams (`/diagram`), tables, collapsible sections, and slash commands. But there is no LSP, no file browsing, no diff review, no code execution, no multi-file editing. Source: [Editor docs](https://linear.app/docs/editor).

**IDE integrations** exist but are connectors, not embedded editors:
- [Linear Connect](https://marketplace.visualstudio.com/items?itemName=Linear.linear-connect): Official VS Code extension for OAuth auth
- VS Code MCP integration: Lets VS Code AI workflows query/update Linear
- [Todo Comments](https://linear.app/integrations/todo-comments): Creates issues from `// TODO:` comments
- [Linear Git Helper](https://marketplace.visualstudio.com/items?itemName=MishalZakeer.linear-git-helper): Automates Linear + Git workflows

Source: [VS Code integration](https://linear.app/integrations/vs-code).

### Git Worktree Isolation

Linear does **not** create git branches or worktrees. It generates a branch name per issue that users copy to clipboard (`Cmd+Shift+.`). Branch naming: `<username>/<team-key>-<issue-number>-<slugified-title>`, configurable in workspace settings. The MCP server exposes `get_issue_git_branch_name` tool. Source: [GitHub integration](https://linear.app/docs/github-integration).

The GitHub integration bi-directionally links issues and PRs. Including the issue ID in branch name or PR title auto-links them. Status automation: branch created -> In Progress, merged -> Done. "Closes TEAM-123" in commit messages triggers transitions. Multiple PRs per issue supported. GitLab and GitHub Enterprise Server also supported. Source: [GitHub integration](https://linear.app/docs/github-integration).

**No worktree support whatsoever**. No creation, management, or awareness of git worktrees. The workflow is: copy branch name, `git checkout -b <branch>` yourself.

### Multi-Provider AI Agents

Linear positions as an **agent orchestration platform**, not an AI coding tool. It has internal AI features (Triage Intelligence, semantic search, Pulse Updates) powered by GPT-4o mini, GPT-5, Gemini 2.0 Flash, and Gemini 2.5 Pro — users cannot choose models or BYOK. Source: [How We Built Triage Intelligence](https://linear.app/now/how-we-built-triage-intelligence).

**Internal AI features**:
- **Triage Intelligence** (Business+): Auto-suggests team routing, assignee, labels, project, duplicates. Uses agentic tool-use with semantic search backend. Can auto-apply suggestions. Source: [Product Intelligence](https://linear.app/changelog/2025-08-14-product-intelligence-technology-preview).
- **Semantic search** (Apr 2025): Hybrid vector embeddings + keyword matching. Understands meaning, not just exact text. Source: [New Search](https://linear.app/changelog/2025-04-10-new-search).
- **Pulse Updates**: AI-generated daily/weekly project summaries, text or audio.
- **Linear Asks** (Business+): Slack/email request intake. Auto-routes to teams, AI-triages, bidirectional sync.

**External agent integrations** (Linear for Agents, May 2025): AI agents are first-class workspace members — assignable, mentionable, governable. Supported agents:

| Agent | Capability |
|-------|-----------|
| Cursor | Background agents turn issues into PRs |
| OpenAI Codex | Answers questions, fixes bugs, explores ideas |
| GitHub Copilot | Converts issues into GitHub PRs |
| Devin | Scopes issues and drafts PRs |
| Sentry (Seer) | Root cause analysis and issue fixes |
| Factory | Codes, tests, creates PRs |
| Warp | Investigates bugs, suggests fixes |

**Deeplink to AI coding tools** (Feb 2026): `Cmd+Alt+.` launches preferred coding tool from an issue with prefilled prompt (issue ID, description, comments, references, images). Supports: Claude Code, Codex, Conductor, Cursor, GitHub Copilot, OpenCode, Replit, v0, Zed. Customizable prompt template. Source: [Deeplink changelog](https://linear.app/changelog/2026-02-26-deeplink-to-ai-coding-tools).

**Why ✗ for "Multi-provider AI agents"**: The SlayZone column means "run multiple AI agents inside the tool." Linear doesn't run agents — it assigns issues TO external agents. It's the task tracker, not the execution environment. No BYOK, no model selection, no local model support.

---

## Pricing

| Plan | Annual Price | Monthly Price | Key Limits |
|------|-------------|--------------|------------|
| **Free** | $0 | $0 | Unlimited members, 2 teams, **250 active issues**, 10MB uploads, basic integrations |
| **Basic** | $10/user/mo | ~$12.50/user/mo | 5 teams, unlimited issues, full API, admin roles |
| **Business** | $16/user/mo | ~$20/user/mo | Unlimited teams, private teams, guests, Triage Intelligence, Insights, Asks, SLAs |
| **Enterprise** | Custom (annual only) | N/A | Sub-initiatives, Advanced Asks, Dashboards, SAML/SCIM, HIPAA BAA |

Special programs: Nonprofit 75% off, Education discounts, Startup program (up to 6 months free).

**Pricing controversies**: The 250-issue hard cap on Free is widely criticized — "makes the free plan impractical for any team shipping regularly" ([tierly.app](https://tierly.app/blog/linear-pricing-teardown)). Guest accounts priced as full users is a common complaint on HN. Feature-gating AI (Triage Intelligence) and analytics to Business ($16/user/mo) creates a steep jump from Basic. Enterprise has hidden costs: annual billing mandatory, $5K-$15K services fees reported. Source: [checkthat.ai](https://checkthat.ai/brands/linear/pricing), [Linear pricing](https://linear.app/pricing).

Vs Jira: Linear's $10/user/mo Basic is slightly more than Jira Standard ($7.91), but Jira's TCO often reaches $20-30/user/mo with Marketplace apps, Confluence, and Guard. Linear's all-inclusive pricing avoids the add-on trap. Source: [Vendr](https://www.vendr.com/marketplace/linear).

---

## Community Sentiment

### What people love

**Speed/performance** (near-universal praise):
- "Linear.app is awesome. We switched from Jira and our team's participation on issues went through the roof." — new_here, [HN](https://news.ycombinator.com/item?id=31932329)
- "Logging bugs, reordering tickets, switching views; it's all near-instant." — [Splotch](https://www.splotch.ink/blog/why-we-switched-from-jira-to-linear)
- Benchmarked 3.7x faster than Jira for common operations — [efficient.app](https://efficient.app/compare/linear-vs-jira)

**Design/UX**:
- "design is world class" ... "It would be hard for me to work somewhere if I wasn't able to use it" — erex78, [HN](https://news.ycombinator.com/item?id=33199304)
- "The gold standard for polished, purposeful UX besides Apple" — Seb, [Trustpilot](https://www.trustpilot.com/review/linear.app) (Jun 2025)
- "pure design porn" — chucky123, [HN](https://news.ycombinator.com/item?id=33199304)

**Keyboard shortcuts**:
- "The keyboard shortcuts and navigation are super fun and very useful." — ZephyrBlu, [HN](https://news.ycombinator.com/item?id=31932329)
- Keyboard-first users measured 61% more efficient — [efficient.app](https://efficient.app/compare/linear-vs-jira)

**Jira escape velocity**:
- "3x better than Jira. So glad we found this tool. Never going back." — Makan, [Trustpilot](https://www.trustpilot.com/review/linear.app) (Jun 2023)
- 8-person team described as "Refugees from JIRA." — fadesibert, [HN](https://news.ycombinator.com/item?id=25553394)
- 20,000+ teams switched including OpenAI, Coinbase, Block — [linear.app/switch](https://linear.app/switch)

### Top complaints

1. **Limited customization / too opinionated** (most cited):
   - "It's _extremely_ opinionated though -- and sneaky because it _looks_ like Trello...but it really isn't" — jakewins, [HN](https://news.ycombinator.com/item?id=39115704)
   - "Only 26% of cross-functional teams reported satisfaction with Linear as their primary tool, compared to 83% of purely technical teams" — [siit.io](https://www.siit.io/tools/trending/linear-app-review)
   - No custom issue types, no arbitrary custom fields, limited reporting

2. **No self-hosting / cloud lock-in**:
   - "There's no self-hosted plan, so for many companies it's a non-starter." — benhurmarcel, [HN](https://news.ycombinator.com/item?id=31932329)
   - Plane (40K+ GitHub stars) gained traction as "Linear without the lock-in" — [openalternative.co](https://openalternative.co/alternatives/linear)

3. **Enterprise feature gaps**:
   - Forrester 2024 rated Linear mid-tier for enterprise readiness, behind Jira/Monday/Azure DevOps — [siit.io](https://www.siit.io/tools/trending/linear-app-review)
   - Engineers rated 3.6/5 for enterprise capabilities vs Jira's 4.4/5

4. **Pricing at scale**:
   - "guest accounts are priced as full users makes it too expensive" — marsouin, [HN](https://news.ycombinator.com/item?id=33199304)
   - "all new features getting locked behind their insanely expensive [Enterprise] plan" — [G2](https://www.g2.com/products/linear/reviews)

5. **Single assignee limitation**:
   - Linear's official position ([X/Twitter](https://x.com/linear/status/1321237282934849537)): "it's by design. We think it's important to have a single issue owner"
   - DRI philosophy frustrates collaborative ownership patterns

6. **Missing features vs Jira**: No documentation/wiki, no time tracking, no Gantt charts, limited reporting
   - "Linear is missing documentation features like Jira Confluence." — Yasith Prabuddhaka, [TrustRadius](https://www.trustradius.com/products/linear/reviews)

7. **Offline/mobile weaknesses**:
   - Offline mode non-functional: "blank window" without internet — crsAbtEvrthng, [HN](https://news.ycombinator.com/item?id=33199304)

8. **Marketing copy**: "pure marketing page, that contains nothing but buzzwords" — olliej, HN

### Known incidents

**January 24, 2024 data loss** ([post-mortem](https://linear.app/now/linear-incident-on-jan-24th-2024)): Faulty DB migration with `TRUNCATE TABLE ... CASCADE` deleted issue descriptions, comments, notifications, favorites, reactions. 12% of workspaces affected, 7% lost automated changes. 99% restored within 36 hours; 4,136 sync packets unrecoverable. Source: [HN discussion](https://news.ycombinator.com/item?id=39115670).

No known CVEs. No documented security breaches beyond the operational data loss.

---

## Company Vitals

- ~70 employees, 100% remote, 16 countries
- 14,000+ customers (early 2025); 20,000+ teams
- Profitable, 140%+ NRR
- Enterprise ARR grew 2000% in 2024
- First Fortune 100 customer in 2024
- 66% of Forbes top 50 AI companies use Linear — [Karri Saarinen on X](https://x.com/karrisaarinen/status/1880314177165869284)

---

## Sources

### Official
- https://linear.app/docs/board-layout: Board layout documentation
- https://linear.app/docs/conceptual-model: Organizational hierarchy
- https://linear.app/docs/mcp: MCP server setup and tools
- https://linear.app/docs/github-integration: GitHub/GitLab integration
- https://linear.app/docs/editor: Rich text editor capabilities
- https://linear.app/docs/security: Security and compliance
- https://linear.app/docs/exporting-data: Data export options
- https://linear.app/docs/slack: Slack integration
- https://linear.app/ai: AI features overview
- https://linear.app/agents: Agent integrations
- https://linear.app/asks: Linear Asks
- https://linear.app/pricing: Current pricing
- https://linear.app/changelog/2025-05-01-mcp: MCP launch
- https://linear.app/changelog/2025-05-20-linear-for-agents: Agent support launch
- https://linear.app/changelog/2025-08-14-product-intelligence-technology-preview: Triage Intelligence
- https://linear.app/changelog/2025-11-20-form-templates: Form templates
- https://linear.app/changelog/2026-02-05-linear-mcp-for-product-management: MCP PM expansion
- https://linear.app/changelog/2026-02-26-deeplink-to-ai-coding-tools: Deeplink to coding tools
- https://linear.app/changelog/2025-04-10-new-search: Semantic search rebuild
- https://linear.app/now/how-we-built-triage-intelligence: AI architecture blog
- https://linear.app/now/scaling-the-linear-sync-engine: Sync engine blog
- https://linear.app/now/linear-incident-on-jan-24th-2024: Data loss post-mortem
- https://linear.app/developers/graphql: GraphQL API docs
- https://linear.app/developers/rate-limiting: API rate limits
- https://linear.app/integrations: Full integration directory

### Community & Analysis
- https://github.com/wzhudev/reverse-linear-sync-engine: Sync engine reverse-engineering
- https://marknotfound.com/posts/reverse-engineering-linears-sync-magic/: Sync protocol analysis
- https://bytemash.net/posts/i-went-down-the-linear-rabbit-hole/: Local-first architecture deep dive
- https://newsletter.pragmaticengineer.com/p/linear: The Pragmatic Engineer profile
- https://cloud.google.com/blog/products/databases/product-workflow-tool-linear-uses-google-cloud-databases: GCP case study
- https://efficient.app/compare/linear-vs-jira: Performance benchmarks
- https://www.shortcutfoo.com/app/dojos/linear-app-mac/cheatsheet: Complete keyboard shortcut list
- https://keycombiner.com/collections/linear/: Keyboard shortcut reference

### Issues & Complaints
- https://news.ycombinator.com/item?id=33199304: Major HN discussion (mixed sentiment)
- https://news.ycombinator.com/item?id=31932329: HN discussion (positive)
- https://news.ycombinator.com/item?id=25553394: Early HN discussion
- https://news.ycombinator.com/item?id=39115704: Data loss incident discussion
- https://www.g2.com/products/linear/reviews: G2 reviews (pros/cons)
- https://www.trustradius.com/products/linear/reviews: TrustRadius reviews
- https://www.trustpilot.com/review/linear.app: Trustpilot reviews
- https://www.siit.io/tools/trending/linear-app-review: Enterprise readiness analysis
- https://www.splotch.ink/blog/why-we-switched-from-jira-to-linear: Jira migration story

### Pricing Analysis
- https://checkthat.ai/brands/linear/pricing: Hidden enterprise costs
- https://tierly.app/blog/linear-pricing-teardown: Free tier limitations
- https://www.vendr.com/marketplace/linear: Pricing comparison

### Security
- https://linear.app/features/secure: Security features page
- https://linear.app/changelog/2021-10-21-soc-2: SOC 2 announcement
- https://linear.app/dpa: Data Processing Agreement

### Press
- https://thenewstack.io/why-linear-built-an-api-for-agents/: Agent API strategy
- https://www.runtime.news/linear-ceo-karri-saarinen-our-customer-base-is-quite-powerful/: CEO interview on agents

## Discrepancies with current table

None — table is up to date. All 10 values confirmed correct:
- Kanban ✓, Local-first ✗, MCP ✓, Keyboard ✓ — all match
- All-per-task ✗, Terminal ✗, Browser ✗, Editor ✗, Worktree ✗, Multi-provider ✗ — all match

**Nuance**: Linear's "local-first sync" architecture (IndexedDB + offline editing) is impressive and could warrant ~ (partial). However, per the column tooltip ("All data stored on your machine. Works offline, no account required"), Linear fails on cloud storage and mandatory account — ✗ is the honest verdict.
