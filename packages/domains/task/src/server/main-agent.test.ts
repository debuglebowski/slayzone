/**
 * `task.startMainAgent` — the hub starts a task's main agent itself, so a client
 * (the phone) need not duplicate the desktop's spawn logic or race it.
 *
 * The router runs against the harness DB with the real task ops; the spawn layer
 * (`pty.*` / `chat.*` ops) is a fake that keeps a live-session registry, and repo
 * discovery is the injected seam (api wires worktrees' `detectChildRepos`).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/domains/task/src/server/main-agent.test.ts
 */
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { TypedEmitter } from '@slayzone/platform/events'
import { setChatDeps, setPtyDeps, type ChatDeps, type PtyDeps } from '@slayzone/terminal/server'
import { listTabsForTask } from '@slayzone/task-terminals/server'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { taskRouter } from './task-router'
import { setTaskDeps } from './task-router-deps'
import { taskOps } from './task-ops-bundle'
import {
  configureTaskRuntimeAdapters,
  getRuntimeAdapters,
  setTaskPathsDelegate
} from './ops/shared'
import { resolveChatAgentLaunch, setMainAgentDeps } from './main-agent'
import { setTaskSessionLedger, type SessionLedgerClient } from './ops'

const h = await createTestHarness()
setTaskDeps({ ops: taskOps })
// The session ledger is on the agents' computer (robustness plan §9); here none is
// connected: reset intents are recorded and wait for it (pinned by the hub's suites).
const published: string[] = []
setTaskSessionLedger({
  publishIntents: async (taskId: string) => {
    published.push(taskId)
  },
  forTask: async () => null,
  sessionModesInScope: async () => null
} as unknown as SessionLedgerClient)
// A task's worktree / custom folder is read from its computer (§9 Phase 7d/7e): this
// fake computer holds what each seeded task names; `away` = not connected.
let pathsAway = false
const computerPaths = new Map<string, { worktreePath: string | null; baseDir: string | null }>()
setTaskPathsDelegate({
  changed: async () => {},
  apply: async () => {},
  release: async () => ({ worktreePath: null, shared: false, computerId: 'pc' }),
  forget: async () => {},
  read: async (taskIds) =>
    Object.fromEntries(
      taskIds.map((id) => {
        if (pathsAway) return [id, { state: 'offline', computerId: 'pc' }]
        const row = computerPaths.get(id)
        return [
          id,
          { state: 'ok', worktreePath: row?.worktreePath ?? null, baseDir: row?.baseDir ?? null }
        ]
      })
    )
})
const caller = taskRouter.createCaller({
  db: h.slayDb,
  dataRoot: mkdtempSync(join(tmpdir(), 'main-agent-'))
})

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

// --- the spawn layer, faked: a live-session registry --------------------------
const MODES = [
  { id: 'claude-code', initialCommand: 'claude --session-id {id} {flags}', enabled: true },
  { id: 'codex', initialCommand: 'codex {flags}', enabled: true },
  { id: 'claude-chat', initialCommand: null, enabled: true },
  { id: 'gemini', initialCommand: 'gemini {flags}', enabled: false }
]
let livePtys: Map<string, string>
let liveChats: Map<string, string>
let ptyCreates: Array<Record<string, unknown>>
let chatStarts: Array<Record<string, unknown>>
let failNextCreate: string | null
let killed: string[]
const ptyOps = {
  ptyKill: (sid: string) => {
    killed.push(`pty:${sid}`)
    livePtys.delete(sid)
    return true
  },
  agentsList: async () => MODES,
  ptyExists: (sid: string) => livePtys.has(sid),
  ptyGetState: (sid: string) => livePtys.get(sid) ?? null,
  sessionGetState: (sid: string) => livePtys.get(sid) ?? liveChats.get(sid) ?? null,
  chatList: () =>
    [...liveChats].map(([sessionId, state]) => ({ sessionId, state, taskId: '', mode: '' })),
  ptyCreate: async (opts: { sessionId: string }) => {
    ptyCreates.push(opts)
    await tick(20) // a spawn takes a while: concurrent callers overlap it
    if (failNextCreate) {
      const error = failNextCreate
      failNextCreate = null
      return { success: false, error }
    }
    livePtys.set(opts.sessionId, 'starting')
    return { success: true }
  }
}
setPtyDeps({ ops: ptyOps as unknown as PtyDeps['ops'], events: new TypedEmitter() } as PtyDeps)
setChatDeps({
  ops: {
    kill: (tabId: string) => {
      killed.push(`chat:${tabId}`)
    },
    start: async (o: { taskId: string; tabId: string }) => {
      chatStarts.push(o)
      await tick(20)
      liveChats.set(`${o.taskId}:${o.tabId}`, 'idle')
      return {}
    }
  },
  queueOps: {},
  events: new TypedEmitter(),
  queueEvents: new TypedEmitter()
} as unknown as ChatDeps)

let detectCalls: Array<{ target: unknown; projectPath: string }>
setMainAgentDeps({
  detectChildRepos: async (target, projectPath) => {
    detectCalls.push({ target, projectPath })
    return [
      { name: 'api', path: `${projectPath}/api` },
      { name: 'web', path: `${projectPath}/web` }
    ]
  }
})

beforeEach(() => {
  livePtys = new Map()
  liveChats = new Map()
  ptyCreates = []
  chatStarts = []
  failNextCreate = null
  detectCalls = []
  killed = []
})

// --- fixtures -------------------------------------------------------------------
function seedProject(path: string | null, selectedRepo: string | null = null): string {
  const id = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, selected_repo) VALUES (?, ?, ?, ?, ?)')
    .run(id, `P-${id.slice(0, 6)}`, '#000', path, selectedRepo)
  return id
}
function seedTask(
  projectId: string,
  extra: {
    mode?: string
    flags?: string
    worktree?: string
    baseDir?: string
    repo?: string
  } = {}
): string {
  const id = crypto.randomUUID()
  const mode = extra.mode ?? 'claude-code'
  h.db
    .prepare(
      `INSERT INTO tasks (id, project_id, title, status, priority, "order", agent_id,
         provider_config, has_worktree, has_base_dir, repo_name)
       VALUES (?, ?, 'T', 'inbox', 3, 0, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      projectId,
      mode,
      JSON.stringify(extra.flags ? { [mode]: { flags: extra.flags } } : {}),
      extra.worktree ? 1 : 0,
      extra.baseDir ? 1 : 0,
      extra.repo ?? null
    )
  computerPaths.set(id, { worktreePath: extra.worktree ?? null, baseDir: extra.baseDir ?? null })
  return id
}

describe('stored chat launch', () => {
  test('resolves main and extra tabs from stored settings', async () => {
    const taskId = seedTask(seedProject('/p'), {
      mode: 'claude-chat',
      flags: '--verbose',
      baseDir: '/base'
    })
    await caller.startMainAgent({ taskId })
    const getTask = (id: string) => taskOps.getTaskOp(h.slayDb, id)
    expect(await resolveChatAgentLaunch(h.slayDb, { taskId, tabId: taskId }, getTask)).toEqual({
      taskId,
      tabId: taskId,
      mode: 'claude-chat',
      cwd: '/base',
      providerFlagsOverride: '--verbose'
    })
    h.db
      .prepare('INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES(?,?,?,1)')
      .run('extra', taskId, 'claude-chat')
    expect(await resolveChatAgentLaunch(h.slayDb, { taskId, tabId: 'extra' }, getTask)).toEqual({
      taskId,
      tabId: 'extra',
      mode: 'claude-chat',
      cwd: '/base',
      providerFlagsOverride: null
    })
    const other = seedTask(seedProject('/other'), { mode: 'claude-chat' })
    await expect(
      resolveChatAgentLaunch(h.slayDb, { taskId: other, tabId: 'extra' }, getTask)
    ).rejects.toThrow('Not found')
    await expect(
      resolveChatAgentLaunch(h.slayDb, { taskId, tabId: 'missing' }, getTask)
    ).rejects.toThrow('Not found')
  })

  test('refuses terminal modes and tasks without a folder', async () => {
    const getTask = (id: string) => taskOps.getTaskOp(h.slayDb, id)
    const taskId = seedTask(seedProject('/p'))
    await caller.startMainAgent({ taskId })
    await expect(
      resolveChatAgentLaunch(h.slayDb, { taskId, tabId: taskId }, getTask)
    ).rejects.toThrow('chat agent')
    const noFolder = seedTask(seedProject(null), { mode: 'claude-chat' })
    h.db
      .prepare('INSERT INTO terminal_tabs(id,task_id,mode,is_main,position) VALUES(?,?,?,1,0)')
      .run(noFolder, noFolder, 'claude-chat')
    await expect(
      resolveChatAgentLaunch(h.slayDb, { taskId: noFolder, tabId: noFolder }, getTask)
    ).rejects.toThrow('no folder')
  })
})

describe('terminal (pty) agents', () => {
  test("starts the agent with the task's own props and ensures its main tab", async () => {
    const taskId = seedTask(seedProject('/p'), { flags: '--x' })
    const r = await caller.startMainAgent({ taskId, cols: 120, rows: 40 })

    expect(r).toEqual({
      sessionId: `${taskId}:${taskId}`,
      tabId: taskId,
      mode: 'claude-code',
      kind: 'pty',
      cwd: '/p',
      state: 'starting',
      started: true
    })
    expect(ptyCreates).toHaveLength(1)
    const opts = ptyCreates[0]
    expect(opts).toMatchObject({
      sessionId: `${taskId}:${taskId}`,
      cwd: '/p',
      mode: 'claude-code',
      providerFlags: '--x',
      cols: 120,
      rows: 40,
      foreground: true,
      existingConversationId: undefined
    })
    // A pre-mint provider with nothing to resume gets a fresh id, as on the desktop.
    expect(opts.conversationId).toMatch(/^[0-9a-f-]{36}$/)
    const tabs = await listTabsForTask(h.slayDb, taskId)
    expect(tabs.find((t) => t.isMain)).toMatchObject({ id: taskId, mode: 'claude-code' })
  })

  test('a call while it runs answers the live session and never replaces it', async () => {
    const taskId = seedTask(seedProject('/p'))
    await caller.startMainAgent({ taskId })
    livePtys.set(`${taskId}:${taskId}`, 'running')
    const again = await caller.startMainAgent({ taskId })
    expect(again).toMatchObject({ started: false, state: 'running', kind: 'pty' })
    expect(ptyCreates).toHaveLength(1)
  })

  test('concurrent calls start it exactly once', async () => {
    const taskId = seedTask(seedProject('/p'))
    const results = await Promise.all([
      caller.startMainAgent({ taskId }),
      caller.startMainAgent({ taskId }),
      caller.startMainAgent({ taskId })
    ])
    expect(ptyCreates).toHaveLength(1)
    expect(results.filter((r) => r.started)).toHaveLength(1)
    expect(new Set(results.map((r) => r.sessionId)).size).toBe(1)
  })

  test('passes no conversation hint: the resume is decided at spawn on the computer', async () => {
    const taskId = seedTask(seedProject('/p'))
    await caller.startMainAgent({ taskId })
    // The pre-minted id is a candidate only: pty-manager resolves the ledger first and
    // never mints over a known conversation (spawn-conversation.test).
    expect(ptyCreates[0].existingConversationId).toBeUndefined()
  })

  test('a provider that mints its own ids gets none', async () => {
    const taskId = seedTask(seedProject('/p'), { mode: 'codex' })
    await caller.startMainAgent({ taskId })
    expect(ptyCreates[0]).toMatchObject({ mode: 'codex' })
    expect(ptyCreates[0].conversationId).toBeUndefined()
  })

  test('a failed spawn is an error, and the next call tries again', async () => {
    const taskId = seedTask(seedProject('/p'))
    failNextCreate = 'no computer available'
    await expect(caller.startMainAgent({ taskId })).rejects.toThrow('no computer available')
    const r = await caller.startMainAgent({ taskId })
    expect(r.started).toBe(true)
    expect(ptyCreates).toHaveLength(2)
  })
})

describe('the working directory, resolved on the hub', () => {
  test('a worktree wins, with no repo discovery', async () => {
    const taskId = seedTask(seedProject('/wrap', 'api'), { worktree: '/wt', baseDir: '/b' })
    expect((await caller.startMainAgent({ taskId })).cwd).toBe('/wt')
    expect(detectCalls).toEqual([])
  })

  test('§9 7d: its computer away — refused visibly, never started in the project folder', async () => {
    const taskId = seedTask(seedProject('/wrap', 'api'), { worktree: '/wt' })
    pathsAway = true
    try {
      await expect(caller.startMainAgent({ taskId })).rejects.toThrow(/not connected/)
    } finally {
      pathsAway = false
    }
  })

  test('then the base dir', async () => {
    const taskId = seedTask(seedProject('/wrap', 'api'), { baseDir: '/b', repo: 'web' })
    expect((await caller.startMainAgent({ taskId })).cwd).toBe('/b')
    expect(detectCalls).toEqual([])
  })

  test("a multi-repo project's bound child repo, discovered on the task's computer", async () => {
    const taskId = seedTask(seedProject('/wrap'), { repo: 'web' })
    expect((await caller.startMainAgent({ taskId })).cwd).toBe('/wrap/web')
    // Addressed by task: discovery runs where this task's agent runs.
    expect(detectCalls).toEqual([{ target: { taskId }, projectPath: '/wrap' }])
  })

  test("the project's default child repo when the task binds none", async () => {
    const taskId = seedTask(seedProject('/wrap', 'api'))
    expect((await caller.startMainAgent({ taskId })).cwd).toBe('/wrap/api')
  })

  test('no child repo bound: the project root, with no discovery', async () => {
    const taskId = seedTask(seedProject('/wrap'))
    expect((await caller.startMainAgent({ taskId })).cwd).toBe('/wrap')
    expect(detectCalls).toEqual([])
  })

  test('nowhere to run: refused, nothing started', async () => {
    const taskId = seedTask(seedProject(null))
    await expect(caller.startMainAgent({ taskId })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED'
    })
    expect(ptyCreates).toEqual([])
  })

  test('an unknown task: NOT_FOUND', async () => {
    await expect(caller.startMainAgent({ taskId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })
})

describe('chat agents', () => {
  test('hydrates and starts the main chat tab with the props the desktop passes', async () => {
    const taskId = seedTask(seedProject('/p'), { mode: 'claude-chat', flags: '--y' })
    const r = await caller.startMainAgent({ taskId })
    expect(r).toEqual({
      sessionId: `${taskId}:${taskId}`,
      tabId: taskId,
      mode: 'claude-chat',
      kind: 'chat',
      cwd: '/p',
      state: 'idle',
      started: true
    })
    expect(chatStarts).toEqual([
      {
        tabId: taskId,
        taskId,
        mode: 'claude-chat',
        cwd: '/p',
        providerFlagsOverride: '--y',
        reason: 'user'
      }
    ])
    expect(ptyCreates).toEqual([])
  })

  test('a live chat is left alone (a re-hydrate with another cwd would replace it)', async () => {
    const taskId = seedTask(seedProject('/p'), { mode: 'claude-chat' })
    liveChats.set(`${taskId}:${taskId}`, 'running')
    const r = await caller.startMainAgent({ taskId })
    expect(r).toMatchObject({ started: false, state: 'running', kind: 'chat' })
    expect(chatStarts).toEqual([])
  })

  test('concurrent calls start it exactly once', async () => {
    const taskId = seedTask(seedProject('/p'), { mode: 'claude-chat' })
    await Promise.all([caller.startMainAgent({ taskId }), caller.startMainAgent({ taskId })])
    expect(chatStarts).toHaveLength(1)
  })
})

describe('task.switchMode', () => {
  const providerConfig = async (taskId: string): Promise<Record<string, unknown>> =>
    JSON.parse(
      (
        h.db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(taskId) as {
          provider_config: string
        }
      ).provider_config
    )

  test('stops the terminal agent, stores the mode, resets the main tab', async () => {
    const taskId = seedTask(seedProject('/p'), { flags: '--x' })
    livePtys.set(`${taskId}:${taskId}`, 'running')

    const updated = await caller.switchMode({ taskId, mode: 'codex' })

    expect(updated.agent_id).toBe('codex')
    expect(killed).toEqual([`pty:${taskId}:${taskId}`])
    // Flags survive (deep merge).
    expect((await providerConfig(taskId))['claude-code']).toMatchObject({ flags: '--x' })
    // The main tab's sessions reset — every mode but the chat ones — as an intent
    // for the task's computer (offline here: it waits), published at once.
    expect(
      h.db
        .prepare('SELECT mode, tab_id, except_chat FROM session_resets WHERE task_id = ?')
        .all(taskId)
    ).toEqual([{ mode: '*', tab_id: taskId, except_chat: 1 }])
    expect(published).toContain(taskId)
    // It does not start the new agent.
    expect(ptyCreates).toEqual([])
  })

  test('INCIDENT: resets only the MAIN tab — a secondary agent tab keeps its session', async () => {
    // The ledger rule (a main-tab reset never cuts another tab) is pinned on the
    // computer (session-ledger.test); here: the intent names the main tab only.
    const taskId = seedTask(seedProject('/p'))
    livePtys.set(`${taskId}:${taskId}`, 'running')
    await caller.switchMode({ taskId, mode: 'codex' })
    await caller.switchMode({ taskId, mode: 'claude-code' })
    const resets = h.db
      .prepare('SELECT tab_id FROM session_resets WHERE task_id = ?')
      .all(taskId) as Array<{ tab_id: string | null }>
    expect(resets.length).toBe(2)
    expect(resets.every((r) => r.tab_id === taskId)).toBe(true)
  })

  test('from a chat mode: stops the chat process, not a pty', async () => {
    const taskId = seedTask(seedProject('/p'), { mode: 'claude-chat' })
    await caller.switchMode({ taskId, mode: 'claude-code' })
    expect(killed).toEqual([`chat:${taskId}`])
  })

  test('same mode: no-op, nothing stopped', async () => {
    const taskId = seedTask(seedProject('/p'))
    const r = await caller.switchMode({ taskId, mode: 'claude-code' })
    expect(r.agent_id).toBe('claude-code')
    expect(killed).toEqual([])
  })

  test('unknown or disabled mode: BAD_REQUEST naming the enabled ones, nothing stopped', async () => {
    const taskId = seedTask(seedProject('/p'))
    await expect(caller.switchMode({ taskId, mode: 'nope' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Unknown agent "nope". Enabled: claude-code, codex, claude-chat'
    })
    await expect(caller.switchMode({ taskId, mode: 'gemini' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Disabled agent "gemini". Enabled: claude-code, codex, claude-chat'
    })
    expect(killed).toEqual([])
  })

  test('an unknown task: NOT_FOUND', async () => {
    await expect(caller.switchMode({ taskId: 'nope', mode: 'codex' })).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })
})
