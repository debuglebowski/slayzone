export const features = [
  {
    number: 1,
    legacyId: 'feat-1',
    slug: 'board',
    title: 'The Board',
    shortDescription:
      "Drag-and-drop columns, tags, sub-tasks, dependencies, due dates, search. All the things you swore you'd never build again after Jira.",
    metaDescription:
      'SlayZone kanban board for parallel AI coding agents. Drag-and-drop columns, tags, subtasks, dependencies, due dates, and search across live agent tasks.',
    details: [
      'The board is the control surface for parallel agent work. It shows the actual state of the project instead of hiding it behind terminal tabs and scattered TODO files.',
      'Tasks stay lightweight enough for fast triage, but still carry structure: tags, due dates, subtasks, dependencies, and status changes that can be driven from the UI or from agent workflows.',
      'The point is not to mimic enterprise project software. It is to make dozens of live coding tasks legible when humans and agents are both moving at once.',
    ],
    highlights: [
      'Board-first task orchestration instead of chat-first agent sessions',
      'Status, dependencies, tags, and search in one surface',
      'Designed for many concurrent tasks without losing the thread',
    ],
  },
  {
    number: 2,
    legacyId: 'feat-2',
    slug: 'terminals',
    title: 'Every card hides a terminal',
    shortDescription:
      'Real PTY sessions for Claude Code, Codex, Gemini, OpenCode, Cursor. Split panes, multiple groups. Not a chat widget with a "copy to clipboard" button.',
    metaDescription:
      'Real PTY terminals for Claude Code, Codex, Gemini, OpenCode, and Cursor inside each SlayZone task card. Split panes, multiple groups, persistent sessions.',
    details: [
      'Each task owns real terminal sessions, not simulated assistant consoles. That means your shell, your environment, and your CLI tools behave the same way they do outside the app.',
      'You can keep multiple terminals per task for agents, dev servers, ad-hoc shell work, or verification commands without collapsing everything into one scrollback.',
      'The terminal model is the foundation for the rest of the product: persistence, agent status, browser control, and usage tracking all plug into the same live session model.',
    ],
    highlights: [
      'Real PTY terminals with your login shell and tooling',
      'Multiple sessions per task for agents and supporting processes',
      'Works with many agent CLIs instead of forcing one provider model',
    ],
  },
  {
    number: 3,
    legacyId: 'feat-3',
    slug: 'embedded-browser',
    title: 'Embedded browser, per task',
    shortDescription:
      'Docs, PRs, localhost, Figma, Notion — embedded per task, resizable alongside your terminals. Alt-tab is a skill you can now unlearn.',
    metaDescription:
      'Embedded browser per SlayZone task for docs, PRs, localhost, Figma, and Notion. Resizable beside terminals. Web context travels with the AI agent task.',
    details: [
      'Every task can keep its own browser context open beside the terminal. That makes docs, local previews, issue trackers, and design references part of the workspace instead of a separate app hop.',
      'Because the browser belongs to the task, the context stays where the work happens. Switching tasks also switches the web surfaces that matter for that task.',
      'This becomes especially useful when agents are involved: the browser is no longer a disconnected human-only tool.',
    ],
    highlights: [
      'Per-task browser panes instead of one shared window',
      'Useful for docs, local previews, PR review, and issue context',
      'Keeps the web context attached to the work item',
    ],
  },
  {
    number: 4,
    legacyId: 'feat-4',
    slug: 'worktrees',
    title: 'Worktrees on autopilot',
    shortDescription:
      'Assign a worktree per task manually, or flip one setting and every new task gets one automatically. Isolated branches, isolated directories. Merge conflicts between tasks become structurally impossible.',
    metaDescription:
      'Automatic git worktrees per SlayZone task. Isolated branches and directories for parallel AI coding agents. No merge conflicts between concurrent tasks.',
    details: [
      'Worktrees are how SlayZone turns parallel task execution from a discipline problem into a default. Each task can get its own branch and working directory without manual setup friction.',
      'That isolation means tasks stop stepping on each other at the filesystem layer. You can keep several refactors, fixes, and experiments moving at once without constant stashing and switching.',
      'The app treats worktree lifecycle as part of task lifecycle so the overhead stays low enough to use on every task, not just the big ones.',
    ],
    highlights: [
      'Automatic or manual worktree assignment per task',
      'Separate branches and directories for parallel changes',
      'Reduces context switching and branch hygiene overhead',
    ],
  },
  {
    number: 5,
    legacyId: 'feat-5',
    slug: 'git-workflow',
    title: 'Stage, commit, ship',
    shortDescription:
      'Full git workflow inside each task card. Stage, unstage, discard, commit. No `git add -p` in a separate terminal like some kind of animal.',
    metaDescription:
      "Full git workflow inside every SlayZone task: stage, unstage, discard, and commit without leaving the AI coding agent terminal and worktree context.",
    details: [
      'Task-local git actions keep the review and shipping loop close to the change itself. You can inspect the task, stage files, write a commit, and move on without breaking flow.',
      'This is not a replacement for advanced git usage. It is the 90 percent path made fast enough that agent-driven workflows do not spill into terminal housekeeping.',
      'The result is less time spent reconstructing what changed where and more time deciding whether the change is actually ready.',
    ],
    highlights: [
      'Stage, unstage, discard, and commit from the task workspace',
      'Keeps source control actions next to the live task context',
      'Faster handoff from coding to review to PR creation',
    ],
  },
  {
    number: 6,
    legacyId: 'feat-6',
    slug: 'diff-viewer',
    title: 'The diff you deserve',
    shortDescription:
      "Unified diff viewer with file status badges, staged/unstaged split, and full-file toggle. You'll still stare at diffs for 20 minutes, but now they're pretty.",
    metaDescription:
      'Unified diff viewer inside SlayZone tasks. File status badges, staged and unstaged split, full-file toggle for reviewing AI coding agent changes.',
    details: [
      'Review is where a lot of agent-assisted workflows still fall apart. The diff view is built to make file-by-file inspection fast without bouncing to another tool.',
      'Staged and unstaged changes stay separated, file state stays visible, and full-file views help when a compact hunk view is not enough to understand the shape of the edit.',
      'This turns review from a context switch into a normal part of finishing work inside the task card.',
    ],
    highlights: [
      'Unified diffs with file-level status and review controls',
      'Separate staged and unstaged views',
      'Full-file mode when hunk views are too narrow',
    ],
  },
  {
    number: 7,
    legacyId: 'feat-7',
    slug: 'commit-graph',
    title: 'Full commit graph, per task',
    shortDescription:
      "Interactive DAG of your commit history. Branch topology, merge paths, tags. Virtualized, so your 14,000-commit monorepo won't kill it.",
    metaDescription:
      'Interactive commit DAG per SlayZone task. Branch topology, merges, and tags visualized. Virtualized rendering handles 14,000-commit monorepos without lag.',
    details: [
      'Task-level git context is not only about current changes. Sometimes the question is how the branch got here, what diverged, and where a merge or rebase will land.',
      'The commit graph surfaces topology directly in the task so branch history and relationships are visible without leaving the workspace.',
      'It is built for real repositories, including ones large enough that naive rendering approaches become useless.',
    ],
    highlights: [
      'Interactive commit DAG inside the task workspace',
      'Useful for branch topology, tags, and merge planning',
      'Virtualized rendering for large repositories',
    ],
  },
  {
    number: 8,
    legacyId: 'feat-8',
    slug: 'pull-requests',
    title: 'PRs without the browser',
    shortDescription:
      'Create, review, comment, merge — squash, rebase, auto-merge, branch cleanup. The entire PR lifecycle without opening GitHub once. Almost.',
    metaDescription:
      'Full PR lifecycle inside SlayZone tasks: create, review, comment, squash, rebase, auto-merge, branch cleanup. GitHub pull requests without the browser.',
    details: [
      'Pull requests are where task context usually fragments across terminals, browsers, and repo tabs. SlayZone keeps the PR loop attached to the originating task.',
      'That means creating a PR, reviewing comments, responding, merging, and cleaning up can happen from the same place where the work and review context already lives.',
      'The goal is to reduce ceremony, not hide the workflow. The task remains the center of gravity from first prompt to merged branch.',
    ],
    highlights: [
      'Create and manage PRs from the task itself',
      'Review comments and merge actions stay in-context',
      'Less tab churn between code, git, and hosting provider UI',
    ],
  },
  {
    number: 9,
    legacyId: 'feat-9',
    slug: 'notes-editor',
    title: 'Rich text editor, per task',
    shortDescription:
      'Rich text editor per task. Markdown, nested checklists, code blocks. For when "TODO: figure this out" needs more than a terminal comment.',
    metaDescription:
      'Rich text editor per SlayZone task. Markdown, nested checklists, and code blocks for AI agent handoff notes, plans, QA steps, and implementation context.',
    details: [
      'Not every task is best represented as terminal output. Some work needs notes, checkpoints, snippets, or a handoff document that survives past the current session.',
      'The built-in editor gives each task a place for structured context: meeting notes, implementation plans, QA steps, or reminders for the next person touching the branch.',
      'Because it lives on the task, the note stays attached to the work instead of vanishing into a separate docs tool.',
    ],
    highlights: [
      'Task-scoped notes with rich text and markdown-like structure',
      'Useful for handoffs, QA notes, and implementation context',
      'Keeps written context next to the live task workspace',
    ],
  },
  {
    number: 10,
    legacyId: 'feat-10',
    slug: 'dev-servers',
    title: 'Dev servers, managed',
    shortDescription:
      "Run watchers, servers, and services at task or project scope. Real-time CPU/memory, logs, auto-restart. Inject process output straight into your agent's terminal.",
    metaDescription:
      'Managed dev servers and watchers per SlayZone task. Real-time CPU/memory, logs, auto-restart. Pipe process output into AI coding agent terminals.',
    details: [
      'Supporting processes are part of real development work, but most agent tools treat them as outside context. SlayZone makes them first-class so tasks can own the servers and watchers they depend on.',
      'That includes visibility into logs and resource usage plus lifecycle controls that do not require keeping extra shell tabs around purely for babysitting.',
      'When needed, process output can become part of the agent workflow instead of something the human has to manually summarize.',
    ],
    highlights: [
      'Manage servers and watchers at task or project scope',
      'Logs plus CPU and memory visibility in the app',
      'Supporting process output can feed back into agent work',
    ],
  },
  {
    number: 11,
    legacyId: 'feat-11',
    slug: 'usage-meter',
    title: 'Token burn rate',
    shortDescription:
      'Live consumption meters per session. Input/output split, cache hit rates. Watch your money evaporate in real time instead of finding out on the invoice.',
    metaDescription:
      'Live token burn rate per AI agent session in SlayZone. Input/output split, cache hit rates for Claude Code and Codex. Spot runaway prompts as they happen.',
    details: [
      'Session-level token visibility makes agent cost legible while work is still happening. That helps spot runaway prompts, bad loops, and waste before the bill arrives.',
      'Because the data is attached to individual sessions, you can compare how different providers or tasks are behaving instead of relying on one aggregate number.',
      'The point is practical control: enough detail to steer usage without turning cost tracking into a spreadsheet ritual.',
    ],
    highlights: [
      'Live token and cache metrics per agent session',
      'Useful for monitoring cost while work is in progress',
      'Makes provider and prompt efficiency visible earlier',
    ],
  },
  {
    number: 12,
    legacyId: 'feat-12',
    slug: 'usage-reports',
    title: 'The invoice prepper',
    shortDescription:
      'Daily token charts, provider breakdown, model-specific metrics, per-task tables, date filtering. Know exactly which task burned $47 on a one-line fix.',
    metaDescription:
      'Daily token charts, provider breakdown, and per-task tables for Claude Code, Codex, and Gemini usage. Know exactly which SlayZone task burned the budget.',
    details: [
      'The session meter is for live steering. The reporting view is for understanding where usage went across a day, week, or billing cycle.',
      'Provider and model breakdowns help answer which tools are actually earning their keep, while per-task tables reveal where cost and output quality are mismatched.',
      'That makes budgeting and team discussions less anecdotal and more grounded in actual task-level behavior.',
    ],
    highlights: [
      'Historical reporting across tasks, providers, and models',
      'Date filtering and breakdowns for real cost analysis',
      'Helps connect spend back to the work that caused it',
    ],
  },
  {
    number: 13,
    legacyId: 'feat-13',
    slug: 'issue-sync',
    title: 'Two-way sync with the outside world',
    shortDescription:
      'Linear, GitHub Issues, Jira. Import tasks, sync statuses, track links. Your PM keeps their tool, you keep yours. Everybody lies about velocity in peace.',
    metaDescription:
      'Two-way sync with Linear, GitHub Issues, and Jira. Import tasks, sync statuses, track links between planning tools and SlayZone AI agent execution.',
    details: [
      'Most teams already have a system of record for issues. SlayZone does not need to replace it to be useful. Instead it can mirror relevant work into the board where execution happens.',
      'Status sync and deep links let the external tool keep its role for planning and reporting while SlayZone handles the day-to-day task execution environment.',
      'That split keeps product and engineering workflows compatible without forcing every stakeholder into the same interface.',
    ],
    highlights: [
      'Import and sync work with external issue trackers',
      'Preserves links between planning tools and execution tasks',
      'Lets teams keep their existing PM surface while engineers work locally',
    ],
  },
  {
    number: 14,
    legacyId: 'feat-14',
    slug: 'explode-mode',
    title: 'Explode mode',
    shortDescription:
      'Cmd+Shift+E. Everything disappears except your open tasks at full width. For when you have six agents running and zero patience for chrome.',
    metaDescription:
      'Cmd+Shift+E explodes SlayZone chrome and shows only open tasks at full width. Built for supervising six parallel AI coding agents without visual noise.',
    details: [
      'Explode mode strips the interface down to the active work so you can focus on the tasks already in motion. It is useful when the board itself becomes secondary to active supervision.',
      'The mode is intentionally blunt: less chrome, more workspace, faster scanning across the tasks that currently matter.',
      'It is a small feature with a large payoff for anyone spending long stretches coordinating multiple live agents.',
    ],
    highlights: [
      'One shortcut to reduce chrome and maximize active workspaces',
      'Built for dense supervision rather than board management',
      'Makes multi-agent monitoring less visually noisy',
    ],
  },
  {
    number: 15,
    legacyId: 'feat-15',
    slug: 'attention-panel',
    title: 'Know when agents need you',
    shortDescription:
      'Terminal state machine detects idle, working, and attention states automatically. Tasks needing human input surface in a notification panel. Desktop alerts included.',
    metaDescription:
      'SlayZone terminal state machine detects idle, working, and attention automatically. AI coding agents that need input surface in a notification queue.',
    details: [
      'Parallel agent work fails when humans have to constantly poll every terminal just to see who is blocked. SlayZone watches terminal output and turns it into visible task state.',
      'When an agent needs a decision, credentials, or manual intervention, that request can surface in an attention queue instead of disappearing into scrollback.',
      'This keeps the human operator focused on exceptions instead of periodic check-ins.',
    ],
    highlights: [
      'Automatic idle, working, and attention-state detection',
      'Surfaces tasks that need human input right away',
      'Reduces manual polling across many agent sessions',
    ],
  },
  {
    number: 16,
    legacyId: 'feat-16',
    slug: 'mcp-board',
    title: 'Agents that read the board',
    shortDescription:
      "MCP server lets agents and CLI tools read task context, update statuses, and complete subtasks from the terminal. Your kanban isn't just for humans anymore.",
    metaDescription:
      'MCP server exposes SlayZone task context to AI coding agents. Read statuses, update tasks, complete subtasks from Claude Code or Codex via the protocol.',
    details: [
      'The board becomes more powerful when agents can read and update it directly. MCP turns task state into something tools can inspect and act on instead of a purely visual UI.',
      'That enables workflows where agents can understand task context, mark progress, complete subtasks, and stay aligned with the board without a human translating everything by hand.',
      'It pushes SlayZone beyond being a window around terminals and toward being shared infrastructure for human-agent coordination.',
    ],
    highlights: [
      'Expose task context to agent tooling through MCP',
      'Agents can update board state instead of only generating code',
      'Moves the board from passive display to active coordination layer',
    ],
  },
]

export function featurePath(feature) {
  return `/features/${feature.slug}`
}

export function featureDemoPath(feature) {
  return `/features/demo/${feature.slug}`
}

export function findFeatureBySlug(slug) {
  return features.find((feature) => feature.slug === slug)
}
