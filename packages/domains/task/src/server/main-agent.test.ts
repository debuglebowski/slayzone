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
import { configureTaskRuntimeAdapters, getRuntimeAdapters } from './ops/shared'
import { setMainAgentDeps } from './main-agent'

const h = await createTestHarness()
// The task's current conversation per mode, as the agent-session ledger would answer
// it (`currentConversationByMode`; the ledger itself is pinned by its own suites).
const conversations = new Map<string, Record<string, string>>()
setTaskDeps({
  ops: {
    ...taskOps,
    getTaskOp: async (db, id) => {
      const t = await taskOps.getTaskOp(db, id)
      const current = conversations.get(id)
      return t && current ? { ...t, currentConversationByMode: current } : t
    }
  }
})
// A worktree task's row carries its worktree colour (worktrees/server's, in the hub).
configureTaskRuntimeAdapters({
  worktrees: {
    ...getRuntimeAdapters().worktrees,
    ensureProjectWorktreeColors: async () => new Map(),
    getWorktreeColor: () => undefined
  }
})
const caller = taskRouter.createCaller({
  db: h.slayDb,
  dataRoot: mkdtempSync(join(tmpdir(), 'main-agent-'))
})

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

// --- the spawn layer, faked: a live-session registry --------------------------
const MODES = [
  { id: 'claude-code', initialCommand: 'claude --session-id {id} {flags}' },
  { id: 'codex', initialCommand: 'codex {flags}' },
  { id: 'claude-chat', initialCommand: null }
]
let livePtys: Map<string, string>
let liveChats: Map<string, string>
let ptyCreates: Array<Record<string, unknown>>
let chatStarts: Array<Record<string, unknown>>
let failNextCreate: string | null
const ptyOps = {
  terminalModesList: async () => MODES,
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
      `INSERT INTO tasks (id, project_id, title, status, priority, "order", terminal_mode,
         provider_config, worktree_path, base_dir, repo_name)
       VALUES (?, ?, 'T', 'inbox', 3, 0, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      projectId,
      mode,
      JSON.stringify(extra.flags ? { [mode]: { flags: extra.flags } } : {}),
      extra.worktree ?? null,
      extra.baseDir ?? null,
      extra.repo ?? null
    )
  return id
}

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

  test("resumes the task's current conversation instead of minting one", async () => {
    const taskId = seedTask(seedProject('/p'))
    conversations.set(taskId, { 'claude-code': 'conv-1' })
    await caller.startMainAgent({ taskId })
    expect(ptyCreates[0]).toMatchObject({
      conversationId: 'conv-1',
      existingConversationId: 'conv-1'
    })
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
