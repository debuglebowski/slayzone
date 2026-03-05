---
name: evaluate-competitor
description: "Evaluate a competitor for the SlayZone comparison table"
---

You are evaluating a competitor for the SlayZone comparison table. The competitor is: $ARGUMENTS

## Instructions

1. Check `comparison/` for any previous research on this competitor. If a file exists, read it first to build on prior findings.

2. Read the current comparison table at `website/comparison.html` to understand the exact features and current data.

3. Launch **3 parallel research agents** to maximize depth:

   **Agent 1 — Platform & per-task features:** For each datapoint below, research official docs, GitHub, changelogs. Write multiple paragraphs per feature with specific URLs.

   **Agent 2 — Architecture deep dive:** Storage format, data flow, privacy model, sandboxing, implementation details. Technical depth with source citations.

   **Agent 3 — Community sentiment:** Reddit threads, HN discussions, forum complaints, pricing backlash, performance issues, security CVEs, competitor comparisons. Real quotes with URLs.

4. For EACH of the following datapoints, the final write-up must include **multiple paragraphs** of analysis (not one-liners). Cover: how it works, implementation details, limitations, community feedback, and comparison to SlayZone's approach.

   **Platform features:**
   - **Kanban board** — Built-in kanban/task board? Any project/task management concept? 3rd-party workarounds? Community requests for it?
   - **Local-first** — Where is data stored exactly? What DB format? What goes to cloud? Offline capability? Privacy modes? Encryption?
   - **MCP server** — Expose MCP server? MCP client? What transports? Config format? What tools available? Resource support?
   - **Keyboard-driven** — Full shortcut list (not just "has shortcuts"). Vim compatibility + known conflicts. Keyboard nav gaps. Mouse-first vs keyboard-first?

   **Per-task features (SlayZone's key differentiator — isolated per task/ticket):**
   - **Terminal** — Real PTY per task or shared/global? Sandboxing details? Auto-execute flow? YOLO mode? Cloud agent terminals?
   - **Embedded browser** — When added? Implementation (Chromium? WebView?)? Agent capabilities? Per-task or shared? Mobile emulation? DevTools?
   - **Code editor** — What makes it different? AI-specific features? Multi-file editing? Diff review? Accept/reject flow?
   - **Git worktree isolation** — Auto or manual? Where stored? Capacity limits? Merge-back flow? Known issues? LSP support?
   - **Multi-provider AI agents** — Complete model list. BYOK: which providers, what limitations, does it route through their servers? Local model support? Mode restrictions?

5. For each datapoint, give a verdict:
   - ✓ (check) — Full support, comparable to or better than SlayZone
   - ✗ (no) — Not supported
   - ~ (partial) — Partially supported, with explanation of limitations

6. Compare findings against the current comparison table. Flag any discrepancies.

7. Save full findings to `comparison/<name>.md` (lowercase, hyphenated). Use this structure:

   ```markdown
   # <Competitor Name>

   > Last evaluated: YYYY-MM-DD
   > Website: <url>
   > GitHub: <url or N/A>
   > Stars: <count or N/A>
   > License: <license>

   ## Summary
   <1-2 sentence description>

   ## Datapoint Evaluation

   | Feature | Verdict | Notes |
   |---------|---------|-------|
   | Kanban board | ✓/✗/~ | ... |
   | ... | ... | ... |

   ---

   ## Detailed Feature Analysis

   ### Kanban / Task Management
   <Multiple paragraphs with citations>

   ### Local-First Architecture
   <Multiple paragraphs: storage schema, cloud dependencies, offline, privacy tiers>

   ### MCP Support
   <Multiple paragraphs: client/server, transports, config, tools, limitations>

   ### Keyboard-Driven
   <Full shortcut list, vim compat, gaps>

   ### Terminal
   <Multiple paragraphs: base terminal, sandboxing, auto-run, cloud agents>

   ### Embedded Browser
   <Timeline, implementation, capabilities, limitations>

   ### Code Editor
   <AI features, diff review, multi-file, unique capabilities>

   ### Git Worktree Isolation
   <How it works, storage, capacity, merge flow, known issues>

   ### Multi-Provider AI Agents
   <Full model table, BYOK details + limitations, local models, mode restrictions>

   ---

   ## Pricing
   <Table of plans + any pricing controversies>

   ## Community Sentiment

   ### What people love
   - <with citations>

   ### Top complaints
   1. <ranked by frequency, with forum/reddit/HN links and quotes>

   ---

   ## Sources

   ### Official
   - <url>: <what>

   ### Community & Analysis
   - <url>: <what>

   ### Issues & Complaints
   - <url>: <what>

   ### Security
   - <url>: <what>

   ### Press
   - <url>: <what>

   ## Discrepancies with current table
   - <any differences found, or "None — table is up to date">
   ```

8. Update the competitor's column in `website/comparison.html` if any values need changing. Use the exact same HTML patterns (classes: `check`, `no`, `partial` with the SVG).

## Quality bar

The goal is an **exhaustive competitive intelligence document** — not a quick summary. Each feature section should be thorough enough that someone could make product decisions based on it. Think: "what would I need to know to debate this competitor's capabilities in a meeting?"

- Every claim must have a source URL
- Include community quotes for sentiment (not just summaries)
- Note security CVEs if any exist
- Cover pricing controversies or changes
- Be honest — if they do something better than SlayZone, say so. The page title is "as-honest-as-I-can"
- If you can't verify a feature, say so rather than guessing
- Focus on what's shipped, not announced/planned
