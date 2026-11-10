/**
 * The demo hub's sample data: three projects with tasks across the board's columns,
 * tags, subtasks, artifacts and four agents in different states. Built fresh each time
 * the demo opens (`seedDemo`), with times relative to that moment, so the lists always
 * read "just now", "2h ago" — and every write the demo takes starts from this again.
 */
import type { Project } from '@slayzone/projects-contracts'
import { type Tag, TAG_PRESETS } from '@slayzone/tags/shared'
import type { ArtifactFolder, Task, TaskArtifact } from '@slayzone/task-contracts'
import type { TerminalTab } from '@slayzone/task-terminals/shared'
import type { TerminalState } from '@slayzone/terminal-contracts'

/** The demo's computer (the one machine its projects run on). */
export const DEMO_COMPUTER_ID = 'demo-computer'

/** `YYYY-MM-DD HH:MM:SS` (UTC), the hub's timestamp format, `minutes` before `now`. */
export function hubTime(now: number, minutes = 0): string {
  return new Date(now - minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ')
}

/** `YYYY-MM-DD`, `days` after `now`. */
function dayAfter(now: number, days: number): string {
  return new Date(now + days * 86_400_000).toISOString().slice(0, 10)
}

export function demoProject(
  now: number,
  fields: Pick<Project, 'id' | 'name' | 'color' | 'sort_order'> & Partial<Project>,
  folder: string
): Project {
  return {
    auto_create_worktree_on_task_create: null,
    worktree_source_branch: null,
    worktree_copy_behavior: null,
    worktree_copy_paths: null,
    worktree_submodule_init: null,
    columns_config: null,
    execution_context: null,
    selected_repo: null,
    task_automation_config: null,
    lock_config: null,
    icon_letters: null,
    icon_image_path: null,
    group_id: null,
    starred: false,
    owner_user_id: 'demo-user',
    default_computer_id: DEMO_COMPUTER_ID,
    created_at: hubTime(now, 60 * 24 * 40),
    updated_at: hubTime(now, 60 * 24),
    placements: [{ computer_id: DEMO_COMPUTER_ID, path: folder, status: 'ready' }],
    resolved_computer_id: DEMO_COMPUTER_ID,
    ...fields
  } as Project
}

/** A task row with every column the hub fills; `fields` set what the demo shows. */
export function demoTask(
  now: number,
  fields: Pick<Task, 'id' | 'project_id' | 'title' | 'status'> & Partial<Task>
): Task {
  return {
    parent_id: null,
    description: null,
    description_format: 'markdown',
    assignee: null,
    priority: 3,
    progress: 0,
    order: 0,
    due_date: null,
    archived_at: null,
    deleted_at: null,
    agent_id: 'claude-chat',
    provider_config: {},
    terminal_shell: null,
    claude_flags: '',
    codex_flags: '',
    cursor_flags: '',
    gemini_flags: '',
    opencode_flags: '',
    dangerously_skip_permissions: false,
    panel_visibility: null,
    panel_sizes: null,
    computer_id: null,
    has_worktree: false,
    worktree_parent_branch: null,
    has_base_dir: false,
    browser_url: null,
    browser_tabs: null,
    web_panel_urls: null,
    editor_open_files: null,
    diff_collapsed_files: null,
    git_active_tab: null,
    merge_state: null,
    merge_context: null,
    loop_config: null,
    snoozed_until: null,
    is_temporary: false,
    is_blocked: false,
    blocked_comment: null,
    pr_url: null,
    active_artifact_id: null,
    artifacts_sidebar: null,
    repo_name: null,
    linear_url: null,
    needs_attention: false,
    dev_url_toast_dismissed: false,
    last_interaction_at: null,
    pinned: false,
    pin_order: 0,
    tree_collapsed: false,
    commit_graph_config: null,
    created_at: hubTime(now, 60 * 24 * 3),
    updated_at: hubTime(now, 60),
    ...fields
  }
}

export function demoArtifact(
  now: number,
  fields: Pick<TaskArtifact, 'id' | 'task_id' | 'title'> & Partial<TaskArtifact>
): TaskArtifact {
  return {
    folder_id: null,
    render_mode: null,
    view_mode: null,
    readability_override: null,
    width_override: null,
    zoom_pct: null,
    html_theme_override: null,
    language: null,
    order: 0,
    created_at: hubTime(now, 90),
    updated_at: hubTime(now, 45),
    current_version_id: null,
    ...fields
  }
}

/** One agent session the demo runs: a task's tab and the state it is in. */
export interface DemoSession {
  taskId: string
  tabId: string
  state: TerminalState
}

export interface DemoSeed {
  projects: Project[]
  tags: Tag[]
  tasks: Task[]
  taskTags: Record<string, string[]>
  /** Tasks another task waits on: blocker id → the tasks it blocks. */
  blocks: Record<string, string[]>
  tabs: TerminalTab[]
  sessions: DemoSession[]
  /** Sessions put to sleep by the idle timeout (💤). */
  hibernated: string[]
  artifacts: TaskArtifact[]
  folders: ArtifactFolder[]
  /** Text artifacts' content by artifact id. */
  content: Record<string, string>
}

// Ids, named for what they are: a test or a deep link can name them.
export const DEMO_IDS = {
  api: 'demo-project-api',
  web: 'demo-project-web',
  infra: 'demo-project-infra',
  search: 'demo-task-search',
  searchIndex: 'demo-task-search-index',
  searchRanking: 'demo-task-search-ranking',
  auth: 'demo-task-auth',
  rateLimit: 'demo-task-rate-limit',
  rateBucket: 'demo-task-rate-bucket',
  rateHeaders: 'demo-task-rate-headers',
  pagination: 'demo-task-pagination',
  emptyQuery: 'demo-task-empty-query',
  node: 'demo-task-node',
  changelog: 'demo-task-changelog',
  darkMode: 'demo-task-dark-mode',
  charts: 'demo-task-charts',
  onboarding: 'demo-task-onboarding',
  layoutShift: 'demo-task-layout-shift',
  backups: 'demo-task-backups',
  tls: 'demo-task-tls',
  planArtifact: 'demo-artifact-search-plan',
  screenshotArtifact: 'demo-artifact-search-screenshot',
  benchArtifact: 'demo-artifact-search-bench',
  authFlowArtifact: 'demo-artifact-auth-flow',
  darkTokensArtifact: 'demo-artifact-dark-tokens',
  notesFolder: 'demo-folder-search-notes'
} as const

const SEARCH_DESCRIPTION = `Full-text search for \`/api/v2/search\`, replacing the \`LIKE\` scan.

## Scope
- Trigram index over \`title\` and \`body\`
- Ranking: exact title match first, then trigram similarity
- Pagination with the same cursor as \`/api/v2/items\`

## Done when
- [x] Index migration runs in under a minute on the staging copy
- [ ] p95 under 80 ms for 3-word queries
- [ ] Docs updated in the API changelog

See the plan artifact for the request flow.`

const AUTH_DESCRIPTION = `Session checks are copied into every route handler. Move them into one middleware so a
route can't forget it.

- One \`requireSession\` middleware, mounted before \`/api/v2\`
- Handlers read \`req.session\` instead of parsing the cookie themselves
- Keep the 401 body exactly as it is today (clients match on it)`

const DARK_MODE_DESCRIPTION = `Add a dark theme to the dashboard and follow the system setting by default.

1. Colour tokens for both themes
2. A toggle in **Settings → Appearance** (System / Light / Dark)
3. Charts read their colours from the tokens`

const PLAN_MD = `# Search endpoint — plan

How a search request flows once the index is in:

\`\`\`mermaid
sequenceDiagram
    participant C as Client
    participant A as API /v2/search
    participant I as Trigram index
    participant D as Postgres
    C->>A: GET /api/v2/search?q=rate limit
    A->>I: similarity(q) > 0.3
    I-->>A: candidate ids (ranked)
    A->>D: fetch rows by id
    D-->>A: rows
    A-->>C: 200 { results, nextCursor }
\`\`\`

## Steps
1. **Migration** — \`CREATE INDEX … USING gin (body gin_trgm_ops)\`
2. **Handler** — \`src/routes/search.ts\`, ranking in \`src/utils/indexer.ts\`
3. **Tests** — ranking order, empty query (400), cursor round-trip

| Query | Before | After |
| --- | --- | --- |
| \`rate limit\` | 412 ms | 38 ms |
| \`auth token refresh\` | 655 ms | 51 ms |
`

const BENCH_MD = `# Benchmarks (staging copy, 1.2M rows)

- 1-word query: **21 ms** p95
- 3-word query: **74 ms** p95
- Index build: 48 s

Measured with \`autocannon -c 20 -d 30\`.`

const AUTH_FLOW_MD = `# Auth flow after the refactor

\`\`\`mermaid
flowchart LR
    R[Request] --> M{requireSession}
    M -- valid cookie --> H[Route handler]
    M -- missing / expired --> E[401 Unauthorized]
    H --> S[(Session store)]
\`\`\`

The handler never parses the cookie: \`req.session\` is set by the middleware or the request
never reaches it.`

const DARK_TOKENS_MD = `# Dark mode tokens

| Token | Light | Dark |
| --- | --- | --- |
| \`background\` | #ffffff | #0b0d12 |
| \`card\` | #f6f7f9 | #141821 |
| \`accent\` | #2563eb | #60a5fa |

Charts take \`accent\` for the primary series.`

/**
 * Colours from desktop's tag palette (`TAG_PRESETS`: three shades per family), the
 * saturated middle shade of a family — the colours a user picks there.
 */
const FAMILY = { red: 0, orange: 1, green: 3, teal: 4, blue: 5, purple: 7, pink: 8, gray: 9 }
const swatch = (family: keyof typeof FAMILY) => TAG_PRESETS[FAMILY[family] * 3 + 1]

export function seedDemo(now: number): DemoSeed {
  const I = DEMO_IDS
  const projects = [
    demoProject(
      now,
      { id: I.api, name: 'API v2', color: swatch('blue').bg, sort_order: 0 },
      '~/dev/projects/api-v2'
    ),
    demoProject(
      now,
      { id: I.web, name: 'Web dashboard', color: swatch('orange').bg, sort_order: 1 },
      '~/dev/projects/web-dashboard'
    ),
    demoProject(
      now,
      { id: I.infra, name: 'Home cloud', color: swatch('green').bg, sort_order: 2 },
      '~/dev/projects/home-cloud'
    )
  ]

  const tag = (
    id: string,
    projectId: string,
    name: string,
    family: keyof typeof FAMILY,
    order: number
  ): Tag => ({
    id,
    project_id: projectId,
    name,
    color: swatch(family).bg,
    text_color: swatch(family).text,
    sort_order: order,
    created_at: hubTime(now, 60 * 24 * 30)
  })
  const tags = [
    tag('demo-tag-feature', I.api, 'feature', 'blue', 0),
    tag('demo-tag-bug', I.api, 'bug', 'red', 1),
    tag('demo-tag-refactor', I.api, 'refactor', 'purple', 2),
    tag('demo-tag-chore', I.api, 'chore', 'gray', 3),
    tag('demo-tag-ui', I.web, 'ui', 'pink', 0),
    tag('demo-tag-web-bug', I.web, 'bug', 'red', 1),
    tag('demo-tag-ops', I.infra, 'ops', 'teal', 0)
  ]

  const t = (fields: Parameters<typeof demoTask>[1]) => demoTask(now, fields)
  const tasks: Task[] = [
    // API v2
    t({
      id: I.search,
      project_id: I.api,
      title: 'Search endpoint',
      status: 'in_progress',
      priority: 2,
      order: 0,
      progress: 60,
      description: SEARCH_DESCRIPTION,
      agent_id: 'codex',
      due_date: dayAfter(now, 3),
      last_interaction_at: now - 2 * 60_000,
      updated_at: hubTime(now, 2)
    }),
    t({
      id: I.searchIndex,
      project_id: I.api,
      parent_id: I.search,
      title: 'Trigram index migration',
      status: 'done',
      order: 0,
      progress: 100
    }),
    t({
      id: I.searchRanking,
      project_id: I.api,
      parent_id: I.search,
      title: 'Ranking tests',
      status: 'in_progress',
      order: 1
    }),
    t({
      id: I.auth,
      project_id: I.api,
      title: 'Auth refactor: session middleware',
      status: 'review',
      priority: 2,
      order: 0,
      description: AUTH_DESCRIPTION,
      agent_id: 'claude-chat',
      needs_attention: true,
      last_interaction_at: now - 14 * 60_000,
      updated_at: hubTime(now, 14)
    }),
    t({
      id: I.pagination,
      project_id: I.api,
      title: 'PR #24: cursor pagination',
      status: 'review',
      priority: 3,
      order: 1,
      agent_id: 'claude-code',
      pr_url: 'https://github.com/example/api-v2/pull/24',
      description: 'Review the cursor encoding and the `nextCursor` contract before merging.',
      updated_at: hubTime(now, 60 * 5)
    }),
    t({
      id: I.rateLimit,
      project_id: I.api,
      title: 'Rate limiting',
      status: 'todo',
      priority: 3,
      order: 0,
      description:
        'Per API key, 600 requests a minute. Blocked until the session middleware lands.',
      due_date: dayAfter(now, 9)
    }),
    t({
      id: I.rateBucket,
      project_id: I.api,
      parent_id: I.rateLimit,
      title: 'Token bucket per API key',
      status: 'todo',
      order: 0
    }),
    t({
      id: I.rateHeaders,
      project_id: I.api,
      parent_id: I.rateLimit,
      title: 'RateLimit-* response headers',
      status: 'todo',
      order: 1
    }),
    t({
      id: I.emptyQuery,
      project_id: I.api,
      title: '500 on an empty search query',
      status: 'todo',
      priority: 1,
      order: 1,
      description: '`GET /api/v2/search?q=` throws instead of answering 400.'
    }),
    t({
      id: I.node,
      project_id: I.api,
      title: 'Upgrade to Node 24',
      status: 'backlog',
      priority: 4,
      order: 0
    }),
    t({
      id: I.changelog,
      project_id: I.api,
      title: 'API changelog for v2.3',
      status: 'done',
      priority: 3,
      order: 0,
      progress: 100,
      updated_at: hubTime(now, 60 * 24 * 2)
    }),
    // Web dashboard
    t({
      id: I.darkMode,
      project_id: I.web,
      title: 'Dark mode',
      status: 'in_progress',
      priority: 2,
      order: 0,
      description: DARK_MODE_DESCRIPTION,
      agent_id: 'claude-chat',
      last_interaction_at: now - 50 * 60_000,
      updated_at: hubTime(now, 50)
    }),
    t({
      id: I.charts,
      project_id: I.web,
      title: 'Usage charts on the overview page',
      status: 'todo',
      priority: 3,
      order: 0
    }),
    t({
      id: I.onboarding,
      project_id: I.web,
      title: 'Onboarding checklist',
      status: 'inbox',
      priority: 3,
      order: 0
    }),
    t({
      id: I.layoutShift,
      project_id: I.web,
      title: 'Layout shift when the sidebar loads',
      status: 'done',
      priority: 2,
      order: 0,
      progress: 100
    }),
    // Home cloud
    t({
      id: I.backups,
      project_id: I.infra,
      title: 'Nightly backups to object storage',
      status: 'todo',
      priority: 2,
      order: 0,
      due_date: dayAfter(now, 1)
    }),
    t({
      id: I.tls,
      project_id: I.infra,
      title: 'Renew TLS certificates',
      status: 'done',
      priority: 3,
      order: 0,
      progress: 100
    })
  ]

  const taskTags: Record<string, string[]> = {
    [I.search]: ['demo-tag-feature'],
    [I.auth]: ['demo-tag-refactor'],
    [I.pagination]: ['demo-tag-feature'],
    [I.rateLimit]: ['demo-tag-feature'],
    [I.emptyQuery]: ['demo-tag-bug'],
    [I.node]: ['demo-tag-chore'],
    [I.darkMode]: ['demo-tag-ui'],
    [I.charts]: ['demo-tag-ui'],
    [I.layoutShift]: ['demo-tag-web-bug'],
    [I.backups]: ['demo-tag-ops'],
    [I.tls]: ['demo-tag-ops']
  }

  const mainTab = (
    taskId: string,
    mode: string,
    agentState: TerminalTab['agentState']
  ): TerminalTab => ({
    id: taskId,
    taskId,
    groupId: taskId,
    label: null,
    mode,
    isMain: true,
    position: 0,
    createdAt: hubTime(now, 60 * 3),
    agentState
  })
  const tabs = [
    mainTab(I.search, 'codex', 'running'),
    mainTab(I.auth, 'claude-chat', 'running'),
    mainTab(I.darkMode, 'claude-chat', 'running'),
    mainTab(I.pagination, 'claude-code', 'auto_stopped')
  ]
  const sessions: DemoSession[] = [
    { taskId: I.search, tabId: I.search, state: 'running' },
    { taskId: I.auth, tabId: I.auth, state: 'idle' },
    { taskId: I.darkMode, tabId: I.darkMode, state: 'idle' }
  ]

  const a = (fields: Parameters<typeof demoArtifact>[1]) => demoArtifact(now, fields)
  const artifacts = [
    a({ id: I.planArtifact, task_id: I.search, title: 'Plan.md', order: 0 }),
    a({ id: I.screenshotArtifact, task_id: I.search, title: 'Codex run.png', order: 1 }),
    a({
      id: I.benchArtifact,
      task_id: I.search,
      folder_id: I.notesFolder,
      title: 'Benchmarks.md',
      order: 0
    }),
    a({ id: I.authFlowArtifact, task_id: I.auth, title: 'Auth flow.md', order: 0 }),
    a({ id: I.darkTokensArtifact, task_id: I.darkMode, title: 'Dark mode tokens.md', order: 0 })
  ]
  const folders: ArtifactFolder[] = [
    {
      id: I.notesFolder,
      task_id: I.search,
      parent_id: null,
      name: 'Notes',
      order: 2,
      created_at: hubTime(now, 120)
    }
  ]

  return {
    projects,
    tags,
    tasks,
    taskTags,
    blocks: { [I.auth]: [I.rateLimit] },
    tabs,
    sessions,
    hibernated: [`${I.pagination}:${I.pagination}`],
    artifacts,
    folders,
    content: {
      [I.planArtifact]: PLAN_MD,
      [I.benchArtifact]: BENCH_MD,
      [I.authFlowArtifact]: AUTH_FLOW_MD,
      [I.darkTokensArtifact]: DARK_TOKENS_MD
    }
  }
}
