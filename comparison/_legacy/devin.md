# Devin

> Last evaluated: 2026-02-28
> Website: https://devin.ai
> GitHub: https://github.com/CognitionAI (org; product is proprietary)
> Stars: N/A (proprietary)
> License: Proprietary (closed-source SaaS)

## Summary

Fully autonomous cloud-based AI software engineer by Cognition Labs. Each session runs in an isolated cloud VM with shell, VS Code Web editor, and Chrome browser. Proprietary model (currently Claude Sonnet 4.5 under the hood). No local execution, no kanban, no multi-provider model choice.

## Datapoint Evaluation

| Feature | Verdict | Notes |
|---------|---------|-------|
| Kanban board | ✗ | No board UI. Flat session list. Delegates to Linear/Jira/Shortcut |
| Local-first | ✗ | Cloud-only. No offline. No local execution (except Enterprise VPC) |
| MCP server | ✓ | Both MCP client (marketplace) and MCP server (mcp.devin.ai) |
| Keyboard-driven | ✗ | Web app, mouse-first. IDE has VS Code shortcuts but outer shell has none |
| Terminal | ✓ | Full Bash shell per cloud VM session. User can interact |
| Embedded browser | ✓ | Chrome per session. Agent + user can control it |
| Code editor | ✓ | VS Code Web with AI features (Cmd+K, Cmd+I, follow mode, diffs) |
| Git worktree isolation | ~ | VM-based isolation (stronger than worktrees) but cloud-only, not local git worktrees |
| Multi-provider AI agents | ✗ | Proprietary model only. No BYOK, no model selection |

---

## Detailed Feature Analysis

### Kanban / Task Management

Devin has **no built-in kanban board, task board, or project management UI**. Work is organized around "sessions" -- each task gets a session, visible in a flat session list at [app.devin.ai/sessions](https://app.devin.ai/sessions). The left sidebar shows active sessions in a collapsible panel, but there is no board view, no columns, no drag-and-drop prioritization, and no concept of task status beyond "active" / "sleeping" / "archived."

Instead of building its own task management, Devin delegates to external tools. It integrates with **Linear** (tag `@Devin` on a ticket or add a Devin label), **Jira** (assign Devin a Jira ticket which becomes a PR), and **Shortcut** ([Shortcut integration docs](https://help.shortcut.com/hc/en-us/articles/37107012887444-Devin-ai-integration)). Slack is the primary interface for spinning up sessions -- you tag `@devin` to offload tasks ([docs.devin.ai/get-started/devin-intro](https://docs.devin.ai/get-started/devin-intro)). The philosophy is that the engineer is the project manager: assign tasks to Devin instances via existing PM tools, then review PRs when they come back.

For parallelism, **MultiDevin** lets a "manager" Devin delegate to up to 10 "worker" Devins in parallel, merging changes into one branch/PR ([cognition.ai/blog/devin-generally-available](https://cognition.ai/blog/devin-generally-available)). But this is orchestration, not a kanban UI. Community tools like [Vibe Kanban](https://www.vibekanban.com/) and [AgentsBoard](https://github.com/Justmalhar/AgentsBoard) have emerged to fill this gap, but Cognition has not shipped anything similar.

### Local-First Architecture

Devin is **entirely cloud-based** with zero local-first capabilities. All computation happens in Cognition's cloud infrastructure. Each session runs in its own isolated cloud VM (Ubuntu 22.04) with a shell, VS Code Web editor, and Chrome browser. The workspace resets to a saved machine state at the start of every session. There is no offline mode, no local execution option for individual users.

**Privacy model:** Cognition achieved **SOC 2 Type II certification in September 2024** ([trust.cognition.ai](https://trust.cognition.ai/)). All data is encrypted in transit and at rest. Customer data is "never used for training" by default; you must explicitly opt in via Data Controls. Enterprise customers' data is never used regardless. Production systems use continuous monitoring, MFA for all employees, and annual security training ([docs.devin.ai/enterprise/security-access/security/enterprise-security](https://docs.devin.ai/enterprise/security-access/security/enterprise-security)).

**Enterprise VPC deployment** runs Devin's development environments (VMs) inside the customer's VPC via AWS PrivateLink or IPSec tunnel. Code never leaves the corporate network. The "brain" (core intelligence) still runs in Cognition's tenant, but only context snippets are sent -- not full repos. The architecture is "entirely stateless" meaning no data stored at rest outside the customer environment ([docs.devin.ai/enterprise/vpc/overview](https://docs.devin.ai/enterprise/vpc/overview)).

**Data retention:** Cognition retains data only for the duration of the customer relationship. Detailed retention policies require NDA access via their Trust Center.

### MCP Support

Devin is **both an MCP client and an MCP server** -- a significant update since the last evaluation.

**As an MCP client:** Devin has an MCP Marketplace (Settings > MCP Marketplace) where you can enable pre-built MCP servers with one click. Supported integrations include Sentry, Datadog, Linear, Figma, Neon, Slack, and many more. Devin supports all 3 MCP transport methods: stdio, SSE, and HTTP. Custom servers can be configured with JSON specifying transport type, command/URL, args, and environment variables ([docs.devin.ai/work-with-devin/mcp](https://docs.devin.ai/work-with-devin/mcp), [cognition.ai/blog/mcp-marketplace](https://cognition.ai/blog/mcp-marketplace)).

**As an MCP server:** Devin exposes itself at `https://mcp.devin.ai/mcp`. External agents (Claude Code, Cursor, etc.) can connect via Streamable HTTP transport with Bearer token auth. This lets other AI systems delegate tasks to Devin programmatically ([mcp.devin.ai](https://mcp.devin.ai/)).

**Third-party MCP servers:** The community-built [kazuph/mcp-devin](https://github.com/kazuph/mcp-devin) bridges Devin sessions with Slack. Cognition also ships a DeepWiki MCP server for AI-accessible documentation of any GitHub repository.

### Keyboard-Driven

Devin is a **web app** at `app.devin.ai` -- fundamentally **mouse-first**. There is no published keyboard shortcut reference, no vim keybindings, and no keyboard navigation system for the session manager or chat interface.

The embedded IDE (VS Code Web) inherits standard VS Code keyboard shortcuts (Cmd+P, Cmd+Shift+P, etc.). The VS Code extension adds `Cmd+G` to start a new Devin and `Cmd+Shift+G` to add context ([github.com/CognitionAI/devin-extension](https://github.com/CognitionAI/devin-extension)). Inside the IDE, `Cmd+K` generates terminal commands from natural language and `Cmd+I` provides inline AI responses.

But the **outer shell** -- session list, chat interface, session controls (sleep/terminate), MCP settings, review UI -- has no documented keyboard shortcuts. You navigate by clicking. There is no vim mode. For keyboard-driven developers, Devin's interaction model is inherently different: you type a task description in chat or Slack, then wait 5-15 minutes for results.

### Terminal

**Each Devin session gets a real terminal (shell)** running inside a sandboxed cloud VM -- a full Bash prompt on Ubuntu 22.04. The terminal is visible in the IDE's Shell tab and shows all commands Devin runs plus outputs. You can toggle the terminal from read-only to writable to run your own commands ([docs.devin.ai/work-with-devin/devin-ide](https://docs.devin.ai/work-with-devin/devin-ide)).

Each VM boots fresh from a machine snapshot using Cognition's custom **otterlink** hypervisor and the open-source **blockdiff** format for instant block-level VM disk snapshots (~15 seconds, down from ~30 minutes on EC2). VMs are used instead of Docker because Devin frequently needs to run Docker itself for spinning up databases and backend services ([cognition.ai/blog/blockdiff](https://cognition.ai/blog/blockdiff), [github.com/CognitionAI/blockdiff](https://github.com/CognitionAI/blockdiff)).

**Auto-execute flow:** Devin autonomously decides when to run commands with no human approval gate before execution. It follows a sequential decision-making approach: write code, compile, run tests, check for errors, iterate. You observe in real-time or review after the fact. There is no "YOLO mode" toggle -- Devin always auto-executes.

**Machine resources:** Users can configure VM size (disk, RAM, CPU) through settings. Machine utilization can be monitored via a widget; an event fires when any resource exceeds 80% capacity ([cognition.ai/blog/dec-24-product-update-2](https://cognition.ai/blog/dec-24-product-update-2)).

### Embedded Browser

**Each Devin session has a Chrome browser instance** that both the agent and user can interact with. Devin uses it to read documentation, check dependencies, test web applications, and navigate websites.

**Interactive Browser** lets users directly control the browser for tasks where Devin needs human help: completing CAPTCHAs, MFA, navigating complex websites. You can test Devin's local builds without leaving the web app ([docs.devin.ai/product-guides/interactive-browser](https://docs.devin.ai/product-guides/interactive-browser)).

The browser runs in the cloud VM sandbox, is per-session and isolated. The memory layer records full replay of browser tabs. In **Devin 2.2** (Feb 2026), "Desktop Computer Use" extends beyond the browser -- Devin can now operate Figma, Photoshop, and other GUI apps through screen interaction ([cognition.ai/blog/introducing-devin-2-2](https://cognition.ai/blog/introducing-devin-2-2)).

### Code Editor

Devin uses **VS Code Web** as its embedded editor with full IDE features: syntax highlighting, file tree, tabs, jump-to-definition, and all standard keyboard shortcuts.

**AI-specific features:**
- **Follow Devin:** Watch edits in real-time
- **Review Changes:** Diff view of all file edits
- **Global Diff:** Summary of all changes across all files
- **Cmd+K:** Generate terminal commands from natural language
- **Cmd+I:** Rapid inline AI responses
- Multi-file editing is standard (Devin commonly edits many files per session)

**Devin Review** (shipped in Devin 2.2) provides sophisticated code review: groups changes logically (not alphabetically by file), detects copied/moved code, highlights probable bugs (red), warnings (yellow), and commentary (gray), offers embedded chat for asking questions about specific hunks. It catches "30% more issues before human review" ([cognition.ai/blog/devin-review](https://cognition.ai/blog/devin-review)).

**VS Code profile import:** You can import local VS Code settings (extensions, keybindings, themes) into Devin's IDE ([docs.devin.ai/collaborate-with-devin/vscode-profiles](https://docs.devin.ai/collaborate-with-devin/vscode-profiles)).

The accept/reject flow happens at the PR level on GitHub -- you merge or request changes on the PR Devin created. The VS Code extension lets you checkout Devin's PRs locally and review/accept in your native IDE.

### Git Worktree Isolation

Devin does **not use git worktrees** in the traditional sense. Instead, each session runs in its own **isolated cloud VM** with a fresh clone of the repo. This provides stronger isolation than worktrees (completely separate filesystem) but operates differently.

**Branch per session:** Devin creates one branch per session, makes changes, and opens a PR. Branch naming is auto-generated but customizable via prompt instructions. Updates to an existing PR push more commits to the same branch.

**Auto PR creation:** Devin autonomously creates PRs when it finishes a task. PRs are authored by a dedicated Devin GitHub user. Devin automatically responds to PR review comments as long as the session is not archived.

**MultiDevin merging:** When using parallel sessions, a manager Devin distributes tasks to workers and merges all successful workers' changes into one branch/PR. Merge conflicts are possible and must be handled.

**Devin Review CLI uses local worktrees:** The Devin Review CLI tool uses `git worktree` on your local machine to check out PR branches for review without disturbing your working directory. This is a client-side tool, not how Devin's agent handles git ([docs.devin.ai/work-with-devin/devin-review](https://docs.devin.ai/work-with-devin/devin-review)).

**Limitation:** No long-term memory across sessions. The context window is bounded per session, so Devin may miss context or make inconsistent changes in large repos.

### Multi-Provider AI Agents

Devin uses **Cognition's proprietary agent system**. The underlying LLM is currently **Anthropic's Claude Sonnet 4.5**, though Cognition has been deliberately opaque about model specifics. Cognition published a blog post explaining they had to "completely rebuild Devin's agent architecture" for Sonnet 4.5 because the model exhibits fundamentally different behaviors. The rebuild resulted in 2x faster performance and 12% improvement on their Junior Developer Evals benchmark ([cognition.ai/blog/devin-sonnet-4-5-lessons-and-challenges](https://cognition.ai/blog/devin-sonnet-4-5-lessons-and-challenges)).

**No model selection for users.** You cannot choose between Claude, GPT, Gemini, or any other model. There is no BYOK option. Devin is vertically integrated -- you use Cognition's agent system.

**Cognition's own model -- SWE-1.5:** Cognition also trains proprietary models. SWE-1.5 is a "frontier-size" architecture built through end-to-end RL on real task environments, generating output at 950 tokens/sec via Cerebras. SWE-1.5 powers Windsurf (Cognition's acquired IDE) rather than Devin directly ([cognition.ai/blog/swe-1-5](https://cognition.ai/blog/swe-1-5)).

**Enterprise custom models:** For Enterprise customers, Cognition offers **Custom Devins** -- fine-tuned versions specialized for specific use cases. Still Cognition's models, not third-party.

---

## Pricing

| Plan | Monthly Cost | ACUs Included | Per-ACU Rate | Concurrent Sessions | Key Features |
|------|-------------|---------------|-------------|---------------------|-------------|
| **Core** | $20/mo | ~9 ACUs | $2.25/ACU | Limited | Pay-as-you-go, auto-recharge |
| **Team** | $500/mo | 250 ACUs | $2.00/ACU | Up to 10 | Multi-user, shared workspace |
| **Enterprise** | Custom | Custom | Custom | Custom | VPC, SSO, SAML/OIDC, custom models, audit logs |

**ACU economics:** 1 ACU = ~15 minutes of active Devin work. Core plan ($2.25/ACU) means one hour costs ~$9. The $20 starter nets ~2.25 hours of agent time. Idle time (waiting for user response, long-running tests, repo setup) is free. Best practice: keep sessions under 10 ACUs (~2.5 hours) as performance degrades in longer sessions.

**History:** Original pricing was $500/mo only (no individual plan). Devin 2.0 (April 2025) added the $20 Core plan -- a 96% price cut for individuals. Devin 2.0 was 83% more efficient per ACU than v1.

**Revenue:** ARR grew from ~$1M (Sept 2024) to ~$73M (June 2025). After Windsurf acquisition (July 2025), combined ARR ~$155M. Valued at $10.2B after $400M raise (Sept 2025).

## Community Sentiment

### What people love
- **Enterprise productivity for well-scoped tasks:** Nubank "saved 20x cost on migration tasks." One org saw "20x efficiency gain for security fixes" (30min human vs 1.5min Devin) ([Trickle Blog](https://trickle.so/blog/devin-ai-review))
- **Async workflow:** "Very good at fixing well-defined tasks that would take a person about an hour to do." Assign via Slack, review PR later ([Frontier AI Substack](https://frontierai.substack.com/p/one-month-of-using-devin))
- **Boilerplate elimination:** "We use Devin for internal dashboards and data migration scripts. Nobody expects production-grade code. We expect a working starting point that saves four hours of boilerplate." ([Sitepoint](https://www.sitepoint.com/devin-ai-engineers-production-realities/))
- **Devin Review:** Free code review tool that groups changes logically, well-received ([cognition.ai/blog/devin-review](https://cognition.ai/blog/devin-review))

### Top complaints

1. **Quality / accuracy of code output (most frequent):** The landmark Answer.AI review tested Devin for a month: **"Out of 20 tasks we attempted, we saw 14 failures, 3 inconclusive results, and just 3 successes"** -- 15% success rate. They concluded it "rarely worked." The Register headline: "'First AI software engineer' is bad at its job." Engineers report "defect rates in agent-generated code at roughly 1.5-2x higher than senior-developer-authored code." ([Answer.AI](https://www.answer.ai/posts/2025-01-08-devin.html), [The Register](https://www.theregister.com/2025/01/23/ai_developer_devin_poor_reviews/))

2. **Pricing / ACU economics:** $20/mo sounds cheap but only gets ~2.25 hours of work. Complex tasks consume credits unpredictably, making budgeting hard. "If you're paying for Devin expecting a 'full AI engineer,' it's a waste." ([Lindy](https://www.lindy.ai/blog/devin-pricing), [Medium](https://medium.com/@vignarajj/devin-ai-the-overhyped-engineer-thats-just-another-fancy-code-refactor-bot-7bed3eb4e464))

3. **Speed / latency:** "A task that would take 30 minutes to complete end-to-end took Devin more than 2 hours." Slack-based workflow means "12-15 minutes between responses." Session startup was ~45s in Devin 2.0, reduced to ~15s in Devin 2.2 ([Trickle Blog](https://trickle.so/blog/devin-ai-review), [Digital Applied](https://www.digitalapplied.com/blog/devin-2-desktop-code-review-ai-engineer-guide))

4. **The controversial launch demo (March 2024):** Independent frame-by-frame analysis showed: "The files Devin is editing don't actually exist in the referenced repository." Upwork demo didn't meet stated requirements. SWE-bench results, while real, "came with caveats that marketing materials glossed over." Codemotion: "Devin has been 'canceled' by a significant portion of the developer community for overpromising." ([HN Discussion](https://news.ycombinator.com/item?id=40008109), [Zeniteq](https://www.zeniteq.com/blog/devins-demo-as-the-first-ai-software-engineer-was-faked), [Codemotion](https://www.codemotion.com/magazine/ai-ml/is-devin-fake/))

5. **Security vulnerabilities:** CVE-2024-56083 (write access via leaked VSCode Live Share URL). Prompt injection: researcher spent $500 testing and found "multiple 0-click attacks" for data exfiltration via shell, browser, and markdown rendering. Cognition was notified April 2025, no fix after 120+ days. ([CVE Details](https://www.cvedetails.com/cve/CVE-2024-56083/), [Embrace The Red](https://embracethered.com/blog/posts/2025/devin-can-leak-your-secrets/))

6. **"Just a wrapper" sentiment:** "Devin AI is not a revolution -- it's an automated code refactoring system dressed up as an engineer." ([Medium](https://medium.com/@vignarajj/devin-ai-the-overhyped-engineer-thats-just-another-fancy-code-refactor-bot-7bed3eb4e464))

---

## Technical Architecture Notes

**Infrastructure:** Custom hypervisor called **otterlink** runs full Ubuntu 22.04 VMs (not Docker). Built and open-sourced **blockdiff** for instant block-level VM disk snapshots using CoW metadata on XFS. VMs used instead of containers because Devin frequently needs to run Docker itself. ([cognition.ai/blog/blockdiff](https://cognition.ai/blog/blockdiff), [github.com/CognitionAI/blockdiff](https://github.com/CognitionAI/blockdiff))

**Session lifecycle:** Sessions can be active, sleeping (VM state preserved), or completed. Machine snapshots enable fast resume. Sleeping sessions consume no ACUs. Sessions expire after 30 days.

**Model details:** Currently runs on Claude Sonnet 4.5 with custom agent orchestration. Cognition's own SWE-1.5 model (trained via end-to-end RL on real coding environments, 950 tok/s via Cerebras) powers Windsurf, not Devin directly. Agent architecture includes planner + executor with tool use (shell, editor, browser). ([cognition.ai/blog/devin-sonnet-4-5-lessons-and-challenges](https://cognition.ai/blog/devin-sonnet-4-5-lessons-and-challenges), [cognition.ai/blog/swe-1-5](https://cognition.ai/blog/swe-1-5))

---

## Sources

### Official
- [docs.devin.ai/get-started/devin-intro](https://docs.devin.ai/get-started/devin-intro): Product overview
- [docs.devin.ai/work-with-devin/devin-ide](https://docs.devin.ai/work-with-devin/devin-ide): IDE features
- [docs.devin.ai/work-with-devin/mcp](https://docs.devin.ai/work-with-devin/mcp): MCP client docs
- [mcp.devin.ai](https://mcp.devin.ai/): MCP server endpoint
- [cognition.ai/blog/mcp-marketplace](https://cognition.ai/blog/mcp-marketplace): MCP marketplace announcement
- [docs.devin.ai/enterprise/vpc/overview](https://docs.devin.ai/enterprise/vpc/overview): VPC deployment
- [docs.devin.ai/enterprise/security-access/security/enterprise-security](https://docs.devin.ai/enterprise/security-access/security/enterprise-security): Security posture
- [cognition.ai/blog/devin-2](https://cognition.ai/blog/devin-2): Devin 2.0 launch
- [cognition.ai/blog/introducing-devin-2-2](https://cognition.ai/blog/introducing-devin-2-2): Devin 2.2 launch
- [cognition.ai/blog/devin-review](https://cognition.ai/blog/devin-review): Devin Review
- [cognition.ai/blog/blockdiff](https://cognition.ai/blog/blockdiff): VM hypervisor tech
- [cognition.ai/blog/devin-sonnet-4-5-lessons-and-challenges](https://cognition.ai/blog/devin-sonnet-4-5-lessons-and-challenges): Model architecture
- [cognition.ai/blog/swe-1-5](https://cognition.ai/blog/swe-1-5): SWE-1.5 model
- [cognition.ai/blog/devin-annual-performance-review-2025](https://cognition.ai/blog/devin-annual-performance-review-2025): 2025 stats
- [devin.ai/pricing](https://devin.ai/pricing/): Pricing
- [github.com/CognitionAI/devin-extension](https://github.com/CognitionAI/devin-extension): VS Code extension
- [github.com/CognitionAI/blockdiff](https://github.com/CognitionAI/blockdiff): Open-source blockdiff

### Community & Analysis
- [swyx.io/cognition](https://www.swyx.io/cognition): Architecture deep-dive
- [answer.ai/posts/2025-01-08-devin.html](https://www.answer.ai/posts/2025-01-08-devin.html): 15% success rate study
- [frontierai.substack.com/p/one-month-of-using-devin](https://frontierai.substack.com/p/one-month-of-using-devin): 1-month review
- [sitepoint.com/devin-ai-engineers-production-realities](https://www.sitepoint.com/devin-ai-engineers-production-realities/): Production reality check
- [builder.io/blog/devin-vs-claude-code](https://www.builder.io/blog/devin-vs-claude-code): Devin vs Claude Code
- [trickle.so/blog/devin-ai-review](https://trickle.so/blog/devin-ai-review): Speed & accuracy tests
- [medium.com/@whynesspower](https://medium.com/@whynesspower/junior-intern-a-review-of-my-past-six-months-with-devin-the-overhyped-ai-software-engineer-91e393c472de): 6-month review

### Issues & Complaints
- [theregister.com](https://www.theregister.com/2025/01/23/ai_developer_devin_poor_reviews/): "Bad at its job" headline
- [futurism.com](https://futurism.com/first-ai-software-engineer-devin-bungling-tasks): "Bungling majority of tasks"
- [codemotion.com](https://www.codemotion.com/magazine/ai-ml/is-devin-fake/): Demo controversy analysis
- [zeniteq.com](https://www.zeniteq.com/blog/devins-demo-as-the-first-ai-software-engineer-was-faked): Demo debunking
- [news.ycombinator.com/item?id=40008109](https://news.ycombinator.com/item?id=40008109): HN demo debunking thread

### Security
- [cvedetails.com/cve/CVE-2024-56083](https://www.cvedetails.com/cve/CVE-2024-56083/): VSCode Live Share write access
- [embracethered.com -- secret leaks](https://embracethered.com/blog/posts/2025/devin-can-leak-your-secrets/): Prompt injection data exfiltration
- [embracethered.com -- kill chain](https://embracethered.com/blog/posts/2025/devin-ai-kill-chain-exposing-ports/): Port exposure attack
- [embracethered.com -- $500 test](https://embracethered.com/blog/posts/2025/devin-i-spent-usd500-to-hack-devin/): Comprehensive security audit
- [pillar.security](https://www.pillar.security/blog/the-hidden-security-risks-of-swe-agents-like-openai-codex-and-devin-ai): SWE agent risk analysis

### Press
- [venturebeat.com](https://venturebeat.com/programming-development/devin-2-0-is-here-cognition-slashes-price-of-ai-software-engineer-to-20-per-month-from-500/): Devin 2.0 price cut
- [techcrunch.com](https://techcrunch.com/2025/09/08/cognition-ai-defies-turbulence-with-a-400m-raise-at-10-2b-valuation/): $10.2B valuation
- [cnbc.com](https://www.cnbc.com/2025/07/11/goldman-sachs-autonomous-coder-pilot-marks-major-ai-milestone.html): Goldman Sachs deployment
- [techcrunch.com](https://techcrunch.com/2025/07/14/cognition-maker-of-the-ai-coding-agent-devin-acquires-windsurf/): Windsurf acquisition

## Discrepancies with current table
- **MCP server: ✗ → ✓** — Devin now exposes an MCP server at mcp.devin.ai AND has an MCP client marketplace with hundreds of integrations. This is a significant change from the previous evaluation.
- All other values are accurate.
