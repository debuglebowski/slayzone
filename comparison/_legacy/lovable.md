# Lovable

> Last evaluated: 2026-02-28
> Website: https://lovable.dev
> GitHub: https://github.com/AntonOsika/gpt-engineer (original OSS, 51K+ stars)
> Stars: 51,000+ (gpt-engineer repo; commercial platform is closed-source)
> License: MIT (original OSS CLI only; commercial platform is proprietary)

## Summary

Lovable is a cloud-based AI web app builder that generates full-stack React + Supabase apps from natural language prompts. Originally launched as GPT Engineer (2023), rebranded January 2025. $653M total funding, $6.6B valuation, ~$200M ARR. Targets non-technical users building MVPs and prototypes — fundamentally different from SlayZone's developer-focused task management approach.

## Datapoint Evaluation

| Feature | Verdict | Notes |
|---------|---------|-------|
| Kanban board | ✗ | No task/project management; prompt-based interface only |
| Local-first | ✗ | Entirely cloud-based; account required; no offline support |
| MCP server | ✗ | MCP client only (connects TO external servers); does not expose one |
| Keyboard-driven | ✗ | One shortcut (Alt+S for visual edits); mouse-first interface |
| Terminal | ✗ | No terminal; top community feature request |
| Embedded browser | ~ | Live preview iframe only; can't browse arbitrary URLs |
| Code editor | ~ | Basic Dev Mode; no diff review or accept/reject flow |
| Git worktree isolation | ✗ | No worktrees; single-branch-at-a-time only |
| Multi-provider AI agents | ✗ | Core agent is Claude-only, not user-selectable |

---

## Detailed Feature Analysis

### Kanban / Task Management

Lovable has **no built-in kanban board, task management, or project management features**. The interface is a chat-based AI agent for generating web apps — there are no concepts of "tasks," "tickets," "stages," or "columns" within the platform's development workflow.

Lovable's marketing pages describe how users can *build* kanban board apps using Lovable as the code generator ([Kanban Boards solution page](https://lovable.dev/solutions/use-case/kanban-boards), [Project Management Tools page](https://lovable.dev/solutions/use-case/project-management-tools)), but these are *outputs* of Lovable, not features of the platform itself. Several community-built demo apps exist on Lovable subdomains (e.g., taskblossom-board.lovable.app) that are user-generated kanban prototypes.

Lovable connects to Linear and Jira via MCP servers ([MCP docs](https://docs.lovable.dev/integrations/mcp-servers)), but these integrations serve as *context sources* for the AI agent — pulling in tickets and PRDs to inform code generation — not as embedded project management views. There is no Lovable UI that displays a board of Linear issues or Jira tickets.

No GitHub issues, feedback board posts, or Reddit threads were found specifically requesting a built-in kanban/task management layer for organizing development work *within* the Lovable platform. This makes sense given Lovable's positioning as an app builder rather than a development environment.

### Local-First Architecture

**Lovable is entirely cloud-based with zero local-first capability.** No offline support. An account is mandatory (email, Google, or GitHub sign-in; users must be 18+).

All project data — source code, AI conversations, version history — is stored on Lovable's cloud infrastructure. The platform runs ephemeral development servers on [Fly.io](https://medium.com/@shantanupawar101/how-loavble-delivers-real-time-code-previews-using-fly-io-e0a24dd7af29) (4,000+ instances), and the backend for user-generated apps runs on [Lovable Cloud](https://docs.lovable.dev/integrations/cloud) (built on Supabase/PostgreSQL). Per their [self-hosting documentation](https://docs.lovable.dev/tips-tricks/self-hosting): *"The Lovable platform itself (the editor and AI agent) is a managed service and cannot be self-hosted or deployed inside a customer VPC."*

Working offline is impossible. The platform requires a persistent internet connection since every code change is synchronized to a cloud-hosted Vite dev server. According to the [privacy policy](https://lovable.dev/privacy), all prompts and generated code pass through Lovable's servers. AI prompts are forwarded on a "pass-through basis" to Anthropic (Claude), OpenAI, Google Gemini, and OpenRouter. Identifiers (name, email, IP), feature usage, prompts, and generated code are all collected.

For encryption: the privacy policy references "industry standard end-to-end encryption" in transit and "database encryption with secure key management" at rest, hosted on SOC 2- and ISO 27001-certified infrastructure. [Data residency](https://docs.lovable.dev/changelog) was added in February 2026 with three regions: Americas, Europe, and Asia Pacific — selectable per project but immutable once chosen.

Lovable originated from the open-source [gpt-engineer](https://github.com/AntonOsika/gpt-engineer) CLI (51K+ stars), [rebranded in January 2025](https://lovable.dev/blog/2025-01-13-rebranding-gpt-engineer-to-lovable). The OSS CLI remains available but is completely separate from the commercial platform. You *can* self-host apps you've *built* with Lovable (standard Vite + React projects), but you cannot self-host the Lovable editor/AI agent itself.

### MCP Support

**Lovable acts as an MCP client (not a server).** It supports connecting to external MCP servers as "personal connectors" but does not expose itself as an MCP server.

MCP support was [announced November 18, 2025](https://lovable.dev/blog/mcp-servers). Lovable's AI agent can pull context from external tools via the Model Context Protocol. Per the [official MCP docs](https://docs.lovable.dev/integrations/mcp-servers):

**Prebuilt connectors** (all plans): Notion, Linear, Jira, Confluence (via Atlassian), Miro, Amplitude, Granola, and n8n (providing access to 400+ downstream integrations).

**Custom MCP servers** (paid plans only): Users can connect arbitrary remote MCP servers via Settings > Connectors > Personal connectors. Configuration requires a server name, URL, and authentication method (OAuth, bearer token/API key, or none). Workspace admins on Business/Enterprise plans can control which MCP servers are available to all users.

**Lovable does NOT expose itself as an MCP server** — you cannot connect Claude Code, Cursor, or another MCP client *to* Lovable to read project state or trigger actions. The MCP integration is one-directional: Lovable reads from external MCP servers to enrich its AI context.

An unofficial community MCP server exists at [hiromima/lovable-mcp-server](https://github.com/hiromima/lovable-mcp-server), designed to give Claude Desktop the ability to analyze Lovable-generated project codebases locally. It is explicitly "not affiliated with Lovable."

This is the critical difference vs SlayZone: SlayZone exposes an MCP server so external AI agents can read task context and update statuses. Lovable consumes MCP but doesn't produce it.

### Keyboard-Driven

**Lovable is overwhelmingly mouse-driven.** There is essentially one documented keyboard shortcut. No vim mode. No keyboard navigation system.

The only confirmed keyboard shortcut is **Option+S** (Mac) / **Alt+S** (Windows) for toggling [Visual Edits mode](https://docs.lovable.dev/features/visual-edit), which enables clicking on UI elements to edit them directly. This shortcut was [restored in the April 4, 2025 changelog](https://docs.lovable.dev/changelog).

Beyond that, the entire interface — prompt input, preview interaction, file browsing, settings, version history — is mouse-driven. There is no vim mode, no emacs keybindings, no keyboard shortcut reference page, and no command palette. The [documentation](https://docs.lovable.dev/introduction) contains no keyboard shortcuts guide or accessibility section.

No documentation, blog posts, or community discussions were found about screen reader support, ARIA attributes, or keyboard navigation gaps. The apps *generated* by Lovable will have whatever accessibility the AI includes in the code, but the Lovable *editor itself* has no documented accessibility features.

This is consistent with Lovable's target audience — non-technical users building apps via chat prompts rather than power-user developers who expect keyboard-centric workflows.

### Terminal

**Lovable has no terminal.** This is a [top community feature request](https://feedback.lovable.dev/p/implement-a-built-in-terminal-for-enhanced-developer-control) that remains unimplemented.

There is no built-in terminal, no PTY, no shell access, and no way to run arbitrary commands. The feature request describes the gap: *"Currently, performing command-line operations like installing packages (npm install firebase) or running scripts often relies on indirect AI instructions, which limits direct control and efficiency."* A [separate terminal request](https://feedback.lovable.dev/p/is-there-a-terminal-available-in-lovable-ai-i-need) also exists on the feedback board.

Lovable's cloud execution environment runs on [Fly.io](https://medium.com/@shantanupawar101/how-loavble-delivers-real-time-code-previews-using-fly-io-e0a24dd7af29) using Firecracker microVMs, spinning up ephemeral Vite dev servers per project. Package installation, dependency management, and build steps are handled implicitly by the AI agent — users describe what they want and the agent modifies `package.json` and runs installs behind the scenes. You cannot SSH into the execution environment.

There is no auto-execute or "YOLO mode" concept since there's no terminal to auto-execute *in*. The AI agent already operates autonomously — it decides what commands to run in the cloud sandbox without user approval for each shell command.

For users who need terminal access, the recommended path is to [export the project to GitHub](https://docs.lovable.dev/integrations/github) and work locally in their own IDE, as described in this [DEV Community article](https://dev.to/tomokat/my-journey-of-setting-up-local-environment-off-of-lovable-app-4469).

### Embedded Browser

**Lovable has a live preview pane that renders the app in real time. It is implemented as a proxied iframe connected to a remote Vite dev server, not a full embedded Chromium browser.**

Per the [Visual Edits engineering blog post](https://lovable.dev/blog/visual-edits): each project gets an ephemeral Vite dev server on Fly.io. The preview is served via a proxy system where the project's subdomain is parsed, routed to the correct machine's internal IPv6 address, and served via iframe. WebSocket traffic for HMR is also proxied. File changes are Base64-encoded, POSTed to the machine's Exec API, written to disk, and the Vite dev server triggers HMR automatically.

Each JSX component receives a unique stable ID via a custom Vite plugin, enabling the visual select tool to trace DOM elements back to their source JSX. The entire project code is synchronized into the browser as an AST using Babel and SWC.

**Mobile emulation**: The [browser testing feature](https://docs.lovable.dev/features/browser-testing) (added February 5, 2026) supports "different screen sizes, including mobile, tablet, and desktop layouts." The preview pane can be resized but is not a full responsive testing tool like Chrome DevTools' device mode.

**DevTools**: Not available to users. The AI agent can read console logs and network requests via the browser testing feature, but users cannot open a DevTools panel.

**Browsing arbitrary URLs**: No. The preview only renders the current project. You cannot navigate to external URLs for documentation, PRs, or any other purpose. This is the key limitation vs SlayZone's embedded Chromium browser, which can browse any URL.

**AI agent interaction**: As of February 2026, the [browser testing feature](https://docs.lovable.dev/features/browser-testing) allows the AI agent to "interact with your app in a real browser running in a virtual environment" — clicking buttons, filling forms, navigating pages, capturing screenshots, reading console logs. Limitations include no support for canvas-based tools, file uploads/downloads, right-click actions, or drag-and-drop.

**Verdict: ~ (partial)** — It's a live preview of the generated app only. Cannot browse arbitrary URLs, view docs, or review PRs. Not a general-purpose embedded browser.

### Code Editor

**Lovable has a built-in code editor called "Dev Mode" / "Code View."** Available to all paid users since [April 4, 2025](https://docs.lovable.dev/changelog). The specific editor library is not publicly documented.

Per the [Dev Mode documentation](https://docs.lovable.dev/features/code-mode), it supports:
- Browse full project file structure (file tree)
- Search across files and jump to specific components
- View and manually edit source code
- Format code directly in the editor
- Copy file content, download individual files, or download full codebase as ZIP
- Reference files in chat using `@` mentions

What is **not** present: no diff view, no accept/reject flow for AI changes, no autocomplete/IntelliSense, no inline diagnostics, no multi-cursor editing. The underlying editor library (Monaco, CodeMirror, or something else) is not disclosed.

For version control of AI changes, Lovable uses a [Versioning 2.0 system](https://lovable.dev/blog/versioning-with-lovable-two-point-zero) (Google Docs-style history with bookmarks and date-grouped edits) rather than a per-change diff/accept/reject flow. You can revert to any previous version (creating a new edit entry, like `git revert`), but you cannot review a diff of individual changes before they're applied.

The Visual Edits feature (distinct from Dev Mode) provides WYSIWYG editing where you click on UI elements and modify text, colors, layout, and fonts directly, [built using client-side AST processing](https://lovable.dev/blog/visual-edits) with Babel, SWC, and a custom Vite plugin.

**Verdict: ~ (partial)** — Basic file browsing and manual editing with syntax highlighting, but missing diff review, accept/reject, autocomplete, and advanced IDE features.

### Git Worktree Isolation

**Lovable does not use git worktrees.** There is no isolation between different feature work.

Per the [GitHub integration documentation](https://docs.lovable.dev/integrations/github), Lovable creates a GitHub repository when you connect a project and maintains two-way sync with the default branch (usually `main`). When you edit in Lovable, changes are saved to a `dev` branch which is then merged into `main`.

[Branch switching](https://docs.lovable.dev/features/labs) is available as an experimental Labs feature, allowing you to select which branch Lovable edits. However, this is single-branch-at-a-time — you cannot work on multiple branches simultaneously or have parallel feature isolation.

Key limitations from the [GitHub integration page](https://docs.lovable.dev/integrations/github):
- One repository per project maximum
- Cannot import existing repositories initially (export-only, then two-way sync)
- Repository path must remain stable — renaming, moving, or deleting breaks the connection
- GitHub account cannot be changed after connection
- No worktree isolation, no parallel branch editing, no per-feature sandboxing
- Only the default branch syncs automatically; feature branches don't appear in Lovable until merged

A [practical guide to environments](https://calochito.medium.com/a-practical-guide-to-dev-staging-and-production-environments-in-lovable-001732f2ac63) describes workflows for managing multiple environments, but these rely on switching branches sequentially rather than parallel isolation.

### Multi-Provider AI Agents

**Lovable's core agent is powered by Anthropic Claude, which is NOT user-selectable.** Users cannot bring their own API keys or choose alternative models for the code generation agent.

There is a critical distinction between two different things:

**The Lovable Agent (core platform AI):** Powered by [Anthropic Claude](https://claude.com/customers/lovable). Per the Anthropic customer story: Lovable chose Claude because it "performed the best on generating code." The agent has been upgraded through Claude 3.7 Sonnet, Claude Opus 4.5, and currently [Claude Opus 4.6](https://docs.lovable.dev/changelog). Users **cannot** switch the agent's model.

**Lovable AI (in-app AI features for generated apps):** A [separate product](https://docs.lovable.dev/integrations/ai) that lets users add AI features (chatbots, summarization, etc.) to the apps they build. Supports 12 models across Google Gemini and OpenAI families. This is for the *generated app's* AI features, not for the code generation agent.

**BYOK:** Not supported for the core agent. A [community feature request](https://feedback.lovable.dev/p/use-your-own-api-keys) exists.

**Local models:** Not supported. All AI traffic routes through Lovable's servers.

This is fundamentally different from SlayZone, which lets you run Claude Code, Codex, Gemini CLI, and more — picking the best agent per task with your own API keys.

---

## Pricing

### Subscription Plans (Feb 2026)

| Plan | Monthly | Credits/mo | Key Features |
|------|---------|-----------|--------------|
| Free | $0 | 5/day (max ~30/mo) | Private projects, unlimited members |
| Pro | $25–$2,250 | 100–10,000 | Custom domains, code mode, remove badge |
| Business | $50–$4,300 | 100–10,000 | SSO, data training opt-out, templates |
| Enterprise | Custom | Custom | Priority SLAs, white-glove onboarding |

Annual billing ~16% discount. Credits roll over (monthly: 1 month validity; annual: through term).

### Credit Costs (approximate)

| Action | Credits |
|--------|---------|
| Simple styling change | ~0.50 |
| Removing a component | ~0.90 |
| Adding authentication | ~1.20 |
| Building full landing page | ~2.00 |
| Chat mode message | ~1.00 |

### Lovable Cloud (separate billing)

- $25/mo free hosting allowance + $1/mo free AI (all plans, through Q1 2026)
- Usage-based beyond free tier
- AI costs at LLM provider rates, no markup
- Auto top-up with configurable monthly limits

### Pricing Controversies

The credit system is the #1 complaint across all review platforms:

- **Unpredictable costs**: *"Spent an entire month's Pro credits in a single afternoon debugging a Stripe integration"*
- **Bug loops consume credits**: Fixing one bug often introduces 3 more; each iteration costs credits even when AI fails
- **Credits lost on cancellation**: Downgrading or canceling loses all remaining credits, including purchased top-ups
- **Triple billing**: Monthly subscription + variable credits + separate Cloud hosting costs. *"The mix of a monthly subscription, a variable-cost credit system, and a separate usage-based cloud bill makes it nearly impossible for a business to forecast expenses"* — [Superblocks analysis](https://www.superblocks.com/blog/lovable-dev-pricing)
- **Pricing described as a "slot machine"** by multiple users
- Users can save 50-70% of credits by debugging in external tools rather than inside Lovable

Sources: [Superblocks](https://www.superblocks.com/blog/lovable-dev-pricing), [DEV Community](https://dev.to/momen_hq/the-hidden-costs-of-vibe-coding-a-practical-look-at-lovables-credit-usage-3cec), [WebsiteBuilderExpert](https://www.websitebuilderexpert.com/vibe-coding/lovable-pricing/)

## Community Sentiment

### What people love

- **Speed of prototyping**: *"did 6 months of work in 2 days"* — Reddit user. Landing pages get 85%+ user satisfaction
- **Design quality** (pre-2.0): Generated UIs praised as polished and professional out of the box
- **Accessibility for non-developers**: *"Lovable's biggest win is how accessible it is — the chat-based setup tears down the barrier to entry for building software"*
- **Full-stack generation**: Auth, database, storage, deployment handled automatically via Supabase integration
- **Code portability**: Standard Vite + React, exportable to GitHub, deployable anywhere

### Top complaints

1. **Credit system / pricing** (60% of negative reviews): Credits burn unpredictably, consumed even when AI fails, lost on cancellation. *"Spent 250+ credits trying to make a simple change — would have been cheaper to hire a programmer"* — [Trustpilot](https://www.trustpilot.com/review/lovable.dev)

2. **Bug loops / debugging spirals** (65-75% of complex projects): *"Fixing a bug, but at the same time introducing 3 more."* Complex features trigger 10-20 fix iterations, each consuming credits. *"Reddit threads filled with users recounting how they burned through tens or even hundreds of credits in hours-long sessions that resulted in zero progress"* — [DesignRevision survey](https://designrevision.com/blog/why-developers-switch-from-lovable-survey-results)

3. **Backend / production limitations** (20-30% satisfaction for complex SaaS): *"Lovable gets you at most 70% of the way there, but you'll spend a lot of time wrestling with that last 30%"* — struggles with payment webhooks, job queues, complex authorization, role-based access

4. **Code quality degradation**: After 20-30 iterations, codebases accumulate unused functions, duplicates, inconsistent naming. Security Grade: 4/10, Testing Grade: 2/10 (independent analysis)

5. **Stack lock-in** (35% of switchers): Locked to React + Supabase. No flexibility for Next.js, custom databases, alternative auth providers, Python/Go backends

6. **Lovable 2.0 regression**: *"The transition to Lovable 2.0 was a fundamental breakdown with functionality regression and pervasive bugs. Features that were reliable in 1.0 suddenly became unpredictable or outright broken."* — [Vibe Coding With Fred](https://vibecodingwithfred.com/blog/lovable-from-hero-to-zero/). *"2.0 UI Design is awful. Descriptive prompts that were creating beautiful UI in 1.0 now in 2.0 it's poo poo"* — Reddit user

7. **Support quality**: *"Great platform, terrible customer service, outrageous attitude"* — [Trustpilot](https://www.trustpilot.com/review/lovable.dev). Support reportedly only available to paying users; even premium subscribers wait days

### Community consensus

*"Prototype in Lovable, then rebuild properly elsewhere."* Common pattern: use Lovable for rapid MVP validation, switch to Cursor/IDE for production work.

### Trustpilot

4/5 stars from 1,054 reviews. 63% five-star, **18% one-star**. Trustpilot flagged Lovable for breaching their guidelines due to fake reviews being removed.

### Hacker News ($330M funding thread)

> "Tons of funding for marketing. Their marketing is everywhere.. But their results or outputs are actually very average." — [mvsingh](https://news.ycombinator.com/item?id=46312611)

> "I don't think they solve any engineering challenges. It's just a fun way to vibe as far as I can tell." — [xenospn](https://news.ycombinator.com/item?id=46312611)

---

## Company Info

| | |
|-|-|
| **Founded** | November 2023, Stockholm, Sweden |
| **Founders** | Anton Osika (CEO), Fabian Hedin (CTO) |
| **HQ** | Stockholm (engineering); Delaware incorporation |
| **Employees** | ~748 (Jan 2026) |
| **Revenue** | ~$200M ARR (Nov 2025) |
| **Total funding** | $653M |
| **Valuation** | $6.6B (Series B, Dec 2025) |

### Funding timeline

| Round | Date | Amount | Lead |
|-------|------|--------|------|
| Pre-seed | Oct 2024 | ~$7.5M | Hummingbird, byFounders |
| Pre-Series A | Feb 2025 | $15M | Creandum |
| Series A | Jul 2025 | $200M | Accel |
| Series B | Dec 2025 | $425M | Menlo Ventures |

### Open source history

- Spring 2023: Anton Osika published `gpt-engineer` on GitHub — CLI tool using GPT-4 to generate codebases. Fastest-growing GitHub repo at the time
- Late 2023: Commercial web version launched as gptengineer.app
- January 2025: Rebranded to Lovable ([blog post](https://lovable.dev/blog/2025-01-13-rebranding-gpt-engineer-to-lovable))
- OSS CLI remains at [github.com/AntonOsika/gpt-engineer](https://github.com/AntonOsika/gpt-engineer) (51K+ stars, MIT license)
- Commercial Lovable platform is closed-source

### Certifications

| Cert | Status |
|------|--------|
| SOC 2 Type II | Audited (Aug 2025) |
| ISO 27001:2022 | Certified |
| GDPR | Aligned |

Trust portal: [trust.lovable.dev](https://trust.lovable.dev/)

---

## Sources

### Official
- https://lovable.dev: Marketing site
- https://docs.lovable.dev: Documentation
- https://docs.lovable.dev/integrations/mcp-servers: MCP integration docs
- https://docs.lovable.dev/features/code-mode: Dev Mode docs
- https://docs.lovable.dev/features/browser-testing: Browser testing docs
- https://docs.lovable.dev/integrations/github: GitHub integration
- https://docs.lovable.dev/integrations/cloud: Lovable Cloud docs
- https://docs.lovable.dev/integrations/ai: Lovable AI (in-app AI features)
- https://docs.lovable.dev/introduction/plans-and-credits: Pricing details
- https://docs.lovable.dev/tips-tricks/self-hosting: Self-hosting limitations
- https://lovable.dev/blog/visual-edits: Visual Edits engineering blog
- https://lovable.dev/blog/lovable-2-0: Lovable 2.0 launch
- https://lovable.dev/blog/mcp-servers: MCP announcement
- https://lovable.dev/blog/2025-01-13-rebranding-gpt-engineer-to-lovable: Rebrand announcement
- https://lovable.dev/privacy: Privacy policy
- https://lovable.dev/security: Security page
- https://lovable.dev/data-processing-agreement: DPA

### Community & Analysis
- https://claude.com/customers/lovable: Anthropic customer story (confirms Claude as core engine)
- https://www.superblocks.com/blog/lovable-dev-review: Independent review
- https://www.superblocks.com/blog/lovable-dev-pricing: Pricing analysis
- https://designrevision.com/blog/why-developers-switch-from-lovable-survey-results: Switcher survey
- https://dev.to/momen_hq/the-hidden-costs-of-vibe-coding-a-practical-look-at-lovables-credit-usage-3cec: Credit analysis
- https://www.eesel.ai/blog/lovable-review: Honest review
- https://www.trustpilot.com/review/lovable.dev: Trustpilot reviews (4/5, 1054 reviews)
- https://vibecodingwithfred.com/blog/lovable-from-hero-to-zero/: 2.0 regression analysis
- https://medium.com/@paul.aqua/from-beloved-to-buggy-why-lovable-2-0-isnt-so-lovable-anymore-4218536a6ade: 2.0 critique
- https://feedback.lovable.dev/p/implement-a-built-in-terminal-for-enhanced-developer-control: Terminal feature request
- https://feedback.lovable.dev/p/use-your-own-api-keys: BYOK feature request
- https://medium.com/@shantanupawar101/how-loavble-delivers-real-time-code-previews-using-fly-io-e0a24dd7af29: Fly.io architecture
- https://www.beam.cloud/blog/agentic-apps: Architecture analysis

### Hacker News
- https://news.ycombinator.com/item?id=42206666: Show HN launch
- https://news.ycombinator.com/item?id=46312611: $330M funding discussion

### Issues & Complaints
- https://www.trustpilot.com/review/lovable.dev: 18% one-star reviews; flagged for fake review removal
- https://vibecodingwithfred.com/blog/lovable-from-hero-to-zero/: 2.0 regression breakdown
- https://designrevision.com/blog/why-developers-switch-from-lovable-survey-results: Why developers leave

### Security
- https://nvd.nist.gov/vuln/detail/CVE-2025-48757: NVD entry — CVSS 8.26, 303 vulnerable endpoints across 170+ apps
- https://mattpalmer.io/posts/CVE-2025-48757/: Original disclosure — missing RLS in Supabase configs
- https://securityonline.info/cve-2025-48757-lovables-row-level-security-breakdown-exposes-sensitive-data-across-hundreds-of-projects/: SecurityOnline analysis
- https://www.theregister.com/2026/02/27/lovable_app_vulnerabilities/: 18K users exposed (UC Berkeley, UC Davis, K-12) — inverted auth logic, 16 vulns in single app
- https://www.semafor.com/article/05/29/2025/the-hottest-new-vibe-coding-startup-lovable-is-a-sitting-duck-for-hackers: Semafor investigation
- https://thehackernews.com/2025/04/lovable-ai-found-most-vulnerable-to.html: VibeScamming — Lovable scored 1.8/10 for phishing resistance (worst tested)
- https://hackread.com/ai-website-builder-lovable-phishing-malware-scams/: Phishing/malware abuse via Lovable
- https://gist.github.com/lhchavez/625ee42a6c408a850d35e50f8e649de9: Technical CVE details
- https://www.superblocks.com/blog/lovable-vulnerabilities: Vulnerability roundup

### Press
- https://techcrunch.com/2025/02/25/swedens-lovable-an-app-building-ai-platform-rakes-in-16m-after-spectacular-growth/: TechCrunch on $15M raise
- https://arcticstartup.com/lovable-raises-e14-3m-pre-series-a/: Arctic Startup funding coverage
- https://www.euronews.com/next/2025/09/08/can-lovable-the-swedish-vibe-coding-start-up-become-europes-first-trillion-dollar-firm: Euronews valuation speculation
- https://www.inc.com/chloe-aiello/5-things-to-know-about-anton-osika-co-founder-of-the-vibe-coding-unicorn-lovable/91223446: Inc profile
- https://metronome.com/blog/what-lovables-pricing-strategy-reveals-about-monetizing-ai-products: Pricing strategy analysis
- https://www.producthunt.com/products/lovable: Product Hunt (5.0/5, 75+ reviews, 1050 upvotes)

## Discrepancies with current table

- **Embedded browser**: Currently ✓, should be **~ (partial)**. Lovable has a live preview iframe that only renders the current project — it cannot browse arbitrary URLs, view docs, or review PRs. Not a general-purpose embedded Chromium browser.
- **Code editor**: Currently ✓, should be **~ (partial)**. Basic Dev Mode with file tree and syntax highlighting, but no diff review, no accept/reject flow for AI changes, no autocomplete/IntelliSense.
