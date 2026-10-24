/**
 * Shared harness for the T-17 owner-check contract tests (`owner-checks.test.ts`,
 * `owner-checks-login-off.test.ts`): a REAL hub — `startServer()`, its real auth,
 * composition, `/trpc` WebSocket listener and routers — booted in this process in a
 * throwaway `SLAYZONE_ROOT`, plus the fixtures and event sources both files use.
 *
 * In-process rather than the built bin (ownership-boot.test.ts) so a test can drive the
 * process-global emitters the hub's routers subscribe to (pty output, chat, prompts,
 * turns …): those are fed by computers and agent hooks a test cannot run, and they are
 * exactly where a stream filter has to hold.
 *
 * Not a test file: no `.test.` in the name, so the runner does not collect it.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { deriveBootstrapOwnerPassword } from '@slayzone/platform/hub-auth-secret'
import { BOOTSTRAP_OWNER_EMAIL } from '@slayzone/platform/hub-owner-file'
import { runWithSecurityContext } from '@slayzone/platform/security-log'
import {
  getAgentLifecycleEvents,
  getAppDeps,
  getAutomationsEvents,
  getChatDeps,
  getMenuEvents,
  getProcessesDeps,
  getPtyDeps,
  type AppRouter
} from '@slayzone/transport/server'
import { agentSessionsEvents, artifactWatcherEvents } from '@slayzone/task/server'
import { tabsEvents } from '@slayzone/task-terminals/server'
import { getGitWatcher } from '@slayzone/worktrees/server'
import { settingsEvents } from '@slayzone/settings/server'
// Not a dependency of the hub app; reached by path so it is the SAME module instance
// the transport routers subscribe to (workspace symlinks resolve to this file).
import {
  agentPromptsEvents,
  agentTurnsEvents
} from '../../../domains/agent-turns/src/server/index.js'
import type { ServerHandle } from './index.js'

export interface InProcessHub {
  readonly root: string
  readonly port: number
  readonly dbPath: string
  /** The bootstrap owner's (first admin's) session token; null without login. */
  readonly adminToken: string | null
  readonly adminUserId: string | null
  stop(): Promise<void>
}

const SECRET = 'owner-checks-test-signing-secret-0123456789-abcdef'
const PUBLIC_ADDRESS = 'hub.example.com'

/**
 * Boot the hub in this process. `login: false` is the desktop app's own hub exactly
 * (supervised, `SLAYZONE_HUB_REQUIRE_LOGIN=0`, loopback). Every inherited SLAYZONE_
 * variable is scrubbed (a task terminal leaks some), and HOME points into the root so
 * nothing reads the developer's real CLI logs or config.
 */
export async function bootInProcessHub(opts: { login: boolean }): Promise<InProcessHub> {
  for (const k of Object.keys(process.env)) if (/^SLAYZONE_/.test(k)) delete process.env[k]
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'slz-owner-checks-')))
  const home = join(root, 'home')
  mkdirSync(home)
  Object.assign(process.env, {
    HOME: home,
    SLAYZONE_ROOT: root,
    SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
    ...(opts.login
      ? {
          SLAYZONE_HUB_PUBLIC_ADDRESS: PUBLIC_ADDRESS,
          SLAYZONE_HUB_REQUIRE_LOGIN: '1',
          SLAYZONE_HUB_AUTH_SECRET: SECRET
        }
      : { SLAYZONE_SUPERVISED: '1', SLAYZONE_HUB_REQUIRE_LOGIN: '0' })
  })
  process.chdir(root)
  // server.ts is written for the CJS bundle (`__dirname`); give its ESM source one.
  const g = globalThis as Record<string, unknown>
  g.__dirname ??= dirname(fileURLToPath(import.meta.url))
  const { startServer } = (await import('./server.js')) as {
    startServer: () => Promise<ServerHandle>
  }
  const handle = await startServer()
  let adminToken: string | null = null
  let adminUserId: string | null = null
  if (opts.login) {
    // A reachable hub writes no owner file (T-11): the owner's password derives from
    // the auth secret, as `slay hub owner-password` prints it.
    const owner = await signIn(
      handle.port,
      BOOTSTRAP_OWNER_EMAIL,
      deriveBootstrapOwnerPassword(SECRET)
    )
    adminToken = owner.token
    adminUserId = owner.userId
  }
  return {
    root,
    port: handle.port,
    dbPath: join(root, 'slayzone.data.sqlite'),
    adminToken,
    adminUserId,
    async stop() {
      await handle.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** Create a `user` account as the admin and sign it in: its id and session token. */
export async function signedInUser(
  hub: InProcessHub,
  email: string
): Promise<{ userId: string; token: string }> {
  const created = await fetch(`http://127.0.0.1:${hub.port}/api/hub/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hub.adminToken}` },
    body: JSON.stringify({ email })
  })
  const body = (await created.json()) as { data: { id: string; password: string } }
  if (!created.ok) throw new Error(`create ${email}: ${created.status} ${JSON.stringify(body)}`)
  return signIn(hub.port, email, body.data.password)
}

/** Password sign-in: the account's id and session token. */
async function signIn(
  port: number,
  email: string,
  password: string
): Promise<{ userId: string; token: string }> {
  // better-auth checks the Origin of a sign-in; the hub's auth base URL is trusted —
  // its public address (`https://`, composition.ts) since T-09.
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${PUBLIC_ADDRESS}` },
    body: JSON.stringify({ email, password })
  })
  const session = (await res.json()) as { token?: string; user?: { id?: string } }
  if (!res.ok || !session.token || !session.user?.id)
    throw new Error(`sign in ${email}: ${res.status}`)
  return { userId: session.user.id, token: session.token }
}

/** A tRPC client over the hub's real `/trpc` socket. Every client says it is window 7
 *  (one subscription delivers only to its own window). */
export function hubClient(hub: InProcessHub, token: string | null) {
  const ws = createWSClient({
    url: `ws://127.0.0.1:${hub.port}/trpc?windowId=7`,
    connectionParams: token ? { token } : undefined
  })
  const client = createTRPCClient<AppRouter>({
    links: [wsLink({ client: ws, transformer: superjson })]
  })
  return { client, close: () => ws.close() }
}

type Callable = {
  query: (input?: unknown) => Promise<unknown>
  mutate: (input?: unknown) => Promise<unknown>
  subscribe: (
    input: unknown,
    handlers: {
      onStarted?: () => void
      onData?: (v: unknown) => void
      onError?: (e: unknown) => void
    }
  ) => { unsubscribe: () => void }
}

/** The client procedure at a dotted path. */
export function procedureAt(client: unknown, path: string): Callable {
  let node = client as Record<string, unknown>
  for (const seg of path.split('.')) node = node[seg] as Record<string, unknown>
  return node as unknown as Callable
}

// ── fixtures ─────────────────────────────────────────────────────────────────

/** One resource of every kind for one owner. Every id and every name carries the
 *  owner's MARK, so a leak shows up as the mark appearing in another user's result. */
export interface Owned {
  readonly mark: string
  readonly userId: string | null
  readonly project: string
  readonly task: string
  readonly tab: string
  readonly session: string
  readonly prompt: string
  readonly turn: string
  readonly artifact: string
  readonly artifactFolder: string
  readonly process: string
  readonly tag: string
  readonly template: string
  readonly testCategory: string
  readonly testLabel: string
  readonly chatQueueItem: string
  readonly automationRun: string
  readonly aiConfigItem: string
  readonly projectGroup: string
  /** The task's worktree (an absolute path). */
  readonly path: string
  readonly automation: string
  /** A computer the owner owns (T-19). */
  readonly computer: string
  /** The same worktree, as a directory walked whole (T-107). */
  readonly pathTree: string
}

export function ownedBy(mark: string, userId: string | null, root: string): Owned {
  const id = (kind: string): string => `${mark}_${kind}`
  return {
    mark,
    userId,
    project: id('project'),
    task: id('task'),
    tab: id('tab'),
    session: id('session'),
    prompt: id('prompt'),
    turn: id('turn'),
    artifact: id('artifact'),
    artifactFolder: id('folder'),
    process: id('process'),
    tag: id('tag'),
    template: id('template'),
    testCategory: id('testCategory'),
    testLabel: id('testLabel'),
    chatQueueItem: id('chatQueue'),
    automationRun: id('automationRun'),
    aiConfigItem: id('aiConfigItem'),
    projectGroup: id('group'),
    path: join(root, 'work', `${mark}_worktree`),
    automation: id('automation'),
    computer: id('computer'),
    pathTree: join(root, 'work', `${mark}_worktree`)
  }
}

/** Write one owner's fixtures straight into the hub's database (WAL: a second
 *  connection is fine while the hub runs). */
export function seedOwned(dbPath: string, o: Owned): void {
  mkdirSync(o.path, { recursive: true })
  const db = new Database(dbPath)
  try {
    const run = (sql: string, ...p: unknown[]): void => void db.prepare(sql).run(...p)
    run(
      `INSERT INTO project_groups (id, name) VALUES (?, ?)`,
      o.projectGroup,
      `${o.mark}_GROUP_NAME`
    )
    run(
      `INSERT INTO projects (id, name, color, owner_user_id, group_id) VALUES (?, ?, '#123456', ?, ?)`,
      o.project,
      `${o.mark}_PROJECT_NAME`,
      o.userId,
      o.projectGroup
    )
    run(
      `INSERT INTO tasks (id, project_id, title, worktree_path) VALUES (?, ?, ?, ?)`,
      o.task,
      o.project,
      `${o.mark}_TASK_TITLE`,
      o.path
    )
    run(
      `INSERT INTO terminal_tabs (id, task_id, mode, is_main) VALUES (?, ?, 'claude-code', 0)`,
      o.tab,
      o.task
    )
    // The main tab was alive at shutdown (auto-restore names the task); a second task
    // has a hibernated main tab (the hibernated-sessions list names it).
    run(
      `INSERT INTO terminal_tabs (id, task_id, mode, is_main, agent_state)
       VALUES (?, ?, 'claude-code', 1, 'running')`,
      o.task,
      o.task
    )
    run(
      `INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)`,
      `${o.mark}_task_hibernated`,
      o.project,
      `${o.mark}_TASK2_TITLE`
    )
    run(
      `INSERT INTO terminal_tabs (id, task_id, mode, is_main, agent_state) VALUES (?, ?, 'claude-code', 1, 'auto_stopped')`,
      `${o.mark}_task_hibernated`,
      `${o.mark}_task_hibernated`
    )
    run(
      `INSERT INTO agent_sessions (id, mode, task_id, tab_id, origin, status, created_at)
       VALUES (?, 'claude-code', ?, ?, 'pending-spawn', 'bound', 0)`,
      o.session,
      o.task,
      o.tab
    )
    run(
      `INSERT INTO agent_prompts (id, task_id, agent_id, text, created_at) VALUES (?, ?, 'claude-code', ?, 0)`,
      o.prompt,
      o.task,
      `${o.mark}_PROMPT_TEXT`
    )
    run(
      `INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, created_at)
       VALUES (?, ?, ?, ?, 'sha', 0)`,
      o.turn,
      o.path,
      o.task,
      o.tab
    )
    run(
      `INSERT INTO artifact_folders (id, task_id, name) VALUES (?, ?, ?)`,
      o.artifactFolder,
      o.task,
      o.mark
    )
    run(
      `INSERT INTO task_artifacts (id, task_id, title) VALUES (?, ?, ?)`,
      o.artifact,
      o.task,
      o.mark
    )
    run(
      `INSERT INTO processes (id, task_id, label, command) VALUES (?, ?, ?, 'true')`,
      o.process,
      o.task,
      o.mark
    )
    run(
      `INSERT INTO tags (id, project_id, name) VALUES (?, ?, ?)`,
      o.tag,
      o.project,
      `${o.mark}_TAG`
    )
    run(`INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)`, o.task, o.tag)
    run(
      `INSERT INTO task_templates (id, project_id, name) VALUES (?, ?, ?)`,
      o.template,
      o.project,
      o.mark
    )
    run(
      `INSERT INTO test_categories (id, project_id, name, pattern) VALUES (?, ?, ?, '*')`,
      o.testCategory,
      o.project,
      o.mark
    )
    run(
      `INSERT INTO test_labels (id, project_id, name) VALUES (?, ?, ?)`,
      o.testLabel,
      o.project,
      o.mark
    )
    run(
      `INSERT INTO chat_queue (id, tab_id, send, original, position) VALUES (?, ?, 's', 'o', 0)`,
      o.chatQueueItem,
      o.tab
    )
    run(
      `INSERT INTO automations (id, project_id, name, trigger_config, actions) VALUES (?, ?, ?, '{}', '[]')`,
      o.automation,
      o.project,
      o.mark
    )
    run(
      `INSERT INTO automation_runs (id, automation_id) VALUES (?, ?)`,
      o.automationRun,
      o.automation
    )
    run(
      `INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content)
       VALUES (?, 'skill', 'project', ?, ?, ?, ?)`,
      o.aiConfigItem,
      o.project,
      o.mark,
      o.mark.toLowerCase(),
      `${o.mark}_SKILL_BODY`
    )
    run(
      `INSERT INTO computers (id, name, platform, version, capabilities_json, last_seen_at,
         created_at, owner_user_id) VALUES (?, ?, 'linux-x64', '0.0.0', '{}', 0, 0, ?)`,
      o.computer,
      `${o.mark}_COMPUTER_NAME`,
      o.userId
    )
    // Usage: distinct token counts per owner, so a sum shows whose rows it took.
    run(
      `INSERT INTO usage_records (id, provider, model, session_id, timestamp, input_tokens, task_id, source_file)
       VALUES (?, 'claude', 'm', ?, datetime('now'), ?, ?, 'f')`,
      `${o.mark}_usage`,
      o.session,
      o.mark.startsWith('A') ? 100_000 : 7,
      o.task
    )
  } finally {
    db.close()
  }
}

/** Facts that span owners: a cross-project blocker (A's task blocks B's), and one
 *  hub-wide integration connection mapped to both projects. */
export function seedShared(dbPath: string, a: Owned, b: Owned): void {
  const db = new Database(dbPath)
  try {
    db.prepare(`INSERT INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)`).run(
      a.task,
      b.task
    )
    db.prepare(
      `INSERT INTO integration_connections (id, provider, credential_ref) VALUES ('conn-shared', 'linear', 'ref')`
    ).run()
    for (const o of [a, b]) {
      db.prepare(
        `INSERT INTO integration_project_mappings
           (id, project_id, provider, connection_id, external_team_id, external_team_key)
         VALUES (?, ?, 'linear', 'conn-shared', 'team', 'KEY')`
      ).run(`${o.mark}_mapping`, o.project)
    }
  } finally {
    db.close()
  }
}

// ── event sources ────────────────────────────────────────────────────────────

/** Run `fn` as if `userId` caused it (what the tRPC entry point does for a call). */
export const asUser = (userId: string | null, fn: () => void): void =>
  runWithSecurityContext({ actor: userId, ip: null, route: 'test' }, fn)

/**
 * For every subscription the owner policy filters by event: one event attributable
 * to `o` — naming o's resources, or (for the signals that name nothing) caused by o.
 * The contract test asserts this table covers every such subscription.
 */
export const EMIT: Record<string, (o: Owned) => void> = {
  'agentLifecycle.onEvent': (o) =>
    getAgentLifecycleEvents().emit('event', {
      agentId: 'claude-code',
      type: 'agent-start',
      taskId: o.task,
      hookEvent: 'UserPromptSubmit',
      timestamp: 0
    } as never),
  'agentPrompts.onChanged': (o) => agentPromptsEvents.emit('agent-prompts:changed', o.task),
  'agentSessions.onChanged': (o) =>
    agentSessionsEvents.emit('agent-sessions:changed', { taskId: o.task }),
  'agentTurns.onChanged': (o) => agentTurnsEvents.emit('agent-turns:changed', o.path),
  'app.browser.onCreateTaskFromLink': (o) =>
    getAppDeps().browser.events.emit('create-task-from-link', {
      viewId: 'v',
      taskId: o.task,
      url: 'https://example.com',
      source: 'context-menu'
    }),
  'app.taskWindows.onListChanged': (o) =>
    getAppDeps().taskWindows.events.emit('list-changed', [o.task]),
  'app.taskWindows.onPrimaryActiveChanged': (o) =>
    getAppDeps().taskWindows.events.emit('primary-active-changed', o.task),
  'app.taskWindows.onOwnershipChanged': (o) =>
    getAppDeps().taskWindows.events.emit('ownership-changed', { taskId: o.task, ownership: [] }),
  'app.taskWindows.onPanelsReleasedOnClose': (o) =>
    getAppDeps().taskWindows.events.emit('panels-released-on-close', {
      closedWindowId: 1,
      released: [{ taskId: o.task, panelId: 'p' }]
    }),
  'app.taskWindows.onPanelCloseRequest': (o) =>
    getAppDeps().taskWindows.events.emit('panels-close-request', 7, {
      taskId: o.task,
      panelId: 'p'
    }),
  'artifacts.onContentChanged': (o) => artifactWatcherEvents.emit('content-changed', o.artifact),
  'chat.onEvent': (o) => getChatDeps().events.emit('event', o.tab, { mark: o.mark } as never, 1),
  'chat.onExit': (o) => getChatDeps().events.emit('exit', o.tab, o.session, 0, null),
  'chat.onQueueChanged': (o) => getChatDeps().queueEvents.emit('queue-changed', o.tab),
  'chat.onQueueDrained': (o) => getChatDeps().queueEvents.emit('queue-drained', o.tab, o.mark),
  'menu.onGoHome': (o) => asUser(o.userId, () => getMenuEvents().emit('go-home')),
  'menu.onToggleGlobalAgentPanel': (o) =>
    asUser(o.userId, () => getMenuEvents().emit('toggle-global-agent-panel')),
  'menu.onToggleAgentStatusPanel': (o) =>
    asUser(o.userId, () => getMenuEvents().emit('toggle-agent-status-panel')),
  'menu.onOpenSettings': (o) => asUser(o.userId, () => getMenuEvents().emit('open-settings')),
  'menu.onOpenProjectSettings': (o) =>
    asUser(o.userId, () => getMenuEvents().emit('open-project-settings')),
  'menu.onNewTemporaryTask': (o) =>
    asUser(o.userId, () => getMenuEvents().emit('new-temporary-task')),
  'menu.onOpenTask': (o) => getMenuEvents().emit('open-task', { taskId: o.task }),
  'menu.onCloseTask': (o) => getMenuEvents().emit('close-task', o.task),
  'menu.onOpenArtifact': (o) =>
    getMenuEvents().emit('open-artifact', { taskId: o.task, artifactId: o.artifact }),
  'menu.onScreenshotTrigger': (o) =>
    asUser(o.userId, () => getMenuEvents().emit('screenshot-trigger')),
  'menu.onCloseCurrentFocus': (o) =>
    asUser(o.userId, () => getMenuEvents().emit('close-current-focus')),
  'menu.onCloseActiveTask': (o) =>
    asUser(o.userId, () => getMenuEvents().emit('close-active-task')),
  'menu.onSyncSessionId': (o) => asUser(o.userId, () => getMenuEvents().emit('sync-session-id')),
  'menu.onReloadBrowser': (o) => asUser(o.userId, () => getMenuEvents().emit('reload-browser')),
  'menu.onReloadApp': (o) => asUser(o.userId, () => getMenuEvents().emit('reload-app')),
  'menu.onZoomFactorChanged': (o) =>
    asUser(o.userId, () => getMenuEvents().emit('zoom-factor-changed', 1.1)),
  'menu.onUpdateStatus': (o) =>
    asUser(o.userId, () => getMenuEvents().emit('update-status', { type: 'checking' } as never)),
  'menu.onBrowserEnsurePanelOpen': (o) =>
    getMenuEvents().emit('browser-ensure-panel-open', { taskId: o.task }),
  'menu.onBrowserCreateTab': (o) =>
    getMenuEvents().emit('browser-create-tab', { taskId: o.task, tabId: o.tab }),
  'menu.onBrowserAgentTouched': (o) =>
    getMenuEvents().emit('browser-agent-touched', { taskId: o.task, tabId: o.tab }),
  // notify.onTasksChanged / onSettingsChanged and task.onChanged are produced by a REAL
  // `task.update` from the owner's own client (see the test), not by an emit here.
  'settings.onThemeChanged': (o) =>
    asUser(o.userId, () => settingsEvents.emit('theme:changed', 'dark')),
  'processes.onLog': (o) => getProcessesDeps().events.emit('log', o.process, o.mark),
  'processes.onStatus': (o) => getProcessesDeps().events.emit('status', o.process, 'running'),
  'processes.onTitle': (o) => getProcessesDeps().events.emit('title', o.process, o.mark),
  'processes.onStats': (o) =>
    getProcessesDeps().events.emit('stats', { [o.process]: { cpu: 1, rss: 1 } } as never),
  'pty.onData': (o) => getPtyDeps().events.emit('data', o.session, `${o.mark}_TERMINAL_BYTES`, 1),
  'pty.onStateChange': (o) =>
    getPtyDeps().events.emit('state-change', o.session, 'running', 'idle'),
  'pty.onTitleChange': (o) => getPtyDeps().events.emit('title-change', o.session, o.mark),
  'pty.onExit': (o) => getPtyDeps().events.emit('exit', o.session, 0, null),
  'pty.onPrompt': (o) => getPtyDeps().events.emit('prompt', o.session, { mark: o.mark }),
  'pty.onSessionDetected': (o) => getPtyDeps().events.emit('session-detected', o.session, o.mark),
  'pty.onDevServerDetected': (o) =>
    getPtyDeps().events.emit('dev-server-detected', o.session, 'http://localhost:1'),
  'pty.onRespawnSuggested': (o) => getPtyDeps().events.emit('respawn-suggested', o.task),
  'pty.onEnsureAlive': (o) => getPtyDeps().events.emit('ensure-alive', o.task, 1, false),
  'pty.onHibernateWarn': (o) => getPtyDeps().events.emit('hibernate-warn', o.session, 5),
  'pty.onHibernateCancelled': (o) => getPtyDeps().events.emit('hibernate-cancelled', o.session),
  'pty.onHibernated': (o) => getPtyDeps().events.emit('hibernated', o.session),
  'pty.onStats': (o) => getPtyDeps().events.emit('stats', { [o.session]: { cpu: 1, rss: 1 } }),
  'pty.onResizeNeeded': (o) => getPtyDeps().events.emit('resize-needed', o.session),
  'taskTerminals.onChanged': (o) => tabsEvents.emit('tabs:changed', { taskId: o.task }),
  'worktrees.onDiffChanged': (o) =>
    getGitWatcher().emit('git:diff-changed', { worktreePath: o.path }),
  'worktrees.onDiffWatchFailed': (o) =>
    getGitWatcher().emit('git:diff-watch-failed', { worktreePath: o.path }),
  // An `admin` subscription (T-106): a void signal, attributed to who caused it.
  'automations.onChanged': (o) => asUser(o.userId, () => getAutomationsEvents().emit('changed'))
}

/** Subscriptions an owner's own `task.update` (a real mutation) produces events on. */
export const BY_MUTATION = ['notify.onTasksChanged', 'notify.onSettingsChanged', 'task.onChanged']
