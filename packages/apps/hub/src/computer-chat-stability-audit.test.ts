import { spawn } from 'node:child_process'
import Database from 'better-sqlite3'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from '@slayzone/task/server'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { createComputerChatServices } from './computer-chat'
import { openChatStorage } from '../../../domains/chat-runtime/src/server/storage'
import { createComputerChatCommandBarrier } from './computer-chat-maintenance'
import { createFakeClaude, echoTurn } from '../../../shared/test-utils/fake-claude'

async function fixture(opts: { spawnProcess?: typeof spawn } = {}) {
  const h = await createTestHarness()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-stability-integration-'))
  // Any provider spawn resolves `claude` to the scripted fake, never to a real
  // CLI that happens to be on this machine's PATH (CI has none; dev boxes do).
  const fakeClaude = createFakeClaude({ root: join(dir, 'fake-claude') })
  h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
  h.db
    .prepare('INSERT INTO tasks(id,project_id,title,worktree_path) VALUES(?,?,?,?)')
    .run('task', 'p', 'Task', dir)
  const openComputer = () =>
    createChatRuntimeHandlers({
      stateDir: dir,
      hubScope: 'hub',
      computerId: () => 'pc',
      getProjectPaths: () => null,
      ...(opts.spawnProcess ? { spawnProcess: opts.spawnProcess } : {}),
      ctx: {
        config: {
          hubUrl: 'ws://hub/computers',
          name: 'test',
          allowedRoots: [realpathSync(tmpdir())],
          capabilities: ['proc'],
          binOverrideDir: fakeClaude.binDir
        },
        dialer: { notify: () => true },
        log: () => {}
      }
    })
  let pc = openComputer()
  let failActivation = false
  const services = (computerId = 'pc', buildMcpEnv = async () => ({})) =>
    createComputerChatServices({
      db: h.slayDb,
      legacyData: {
        ...createDbChatDataOps(h.slayDb, taskSessionStore),
        buildMcpEnv
      },
      attachments: { read: async () => new Uint8Array() },
      request: async (_id, raw) => {
        if ((raw as { kind: string }).kind === 'migration.activate' && failActivation) {
          failActivation = false
          throw new Error('Disconnected before migration activation')
        }
        return pc.request(JSON.parse(JSON.stringify(raw)))
      },
      resolveComputer: async () => computerId,
      defaultComputer: async () => computerId,
      hasLiveTask: async () => false
    })
  return {
    ...h,
    dir,
    fakeClaude,
    request: (raw: unknown) => pc.request(JSON.parse(JSON.stringify(raw))),
    services,
    failActivation: () => {
      failActivation = true
    },
    restartComputer: async () => {
      await pc.close()
      pc = openComputer()
    },
    close: async () => {
      await pc.close()
      fakeClaude.dispose()
      h.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

// Keep this real hub/computer storage recovery integration: mocks cannot prove persisted ownership, activation and content survive reopening together. Operations are awaited and fixtures are isolated. A rare outer watchdog timeout under deliberately oversubscribed host load is acceptable as an infrastructure signal; investigate isolated failure before declaring a storage regression.
test('audit: normal reopen recovers a hub commit whose computer activation was interrupted', async () => {
  const f = await fixture()
  try {
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    f.db
      .prepare(
        "INSERT INTO chat_tab_state(tab_id,draft_text,rev,updated_at) VALUES('tab','preserve draft',3,123)"
      )
      .run()
    const before = f.services()
    f.failActivation()
    await expect(before.relay.ops.getTabState('tab')).rejects.toThrow(
      'Disconnected before migration activation'
    )
    expect(await before.ownership.forTab('tab')).toMatchObject({
      state: 'active',
      epoch: 2,
      cleanupPending: true
    })
    await f.restartComputer()
    const after = f.services()
    await expect(after.relay.ops.getTabState('tab')).resolves.toMatchObject({
      draft: { text: 'preserve draft' }
    })
    expect(await after.ownership.forTab('tab')).toMatchObject({ cleanupPending: false })
  } finally {
    await f.close()
  }
})

// Keep this real hub/computer storage recovery integration: mocks cannot prove persisted ownership, activation and content survive reopening together. Operations are awaited and fixtures are isolated. A rare outer watchdog timeout under deliberately oversubscribed host load is acceptable as an infrastructure signal; investigate isolated failure before declaring a storage regression.
test('audit: native-only prompt history must not add a visible chat terminal on reconnect', async () => {
  const f = await fixture()
  try {
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('native-tab','task','codex',0)"
      )
      .run()
    f.db
      .prepare(
        "INSERT INTO agent_prompts(id,task_id,agent_id,text,created_at) VALUES('prompt','task','codex','native prompt',123)"
      )
      .run()
    const before = f.services()
    expect(await before.prompts('task', 'codex')).toMatchObject([{ text: 'native prompt' }])
    const tabs = f.db
      .prepare('SELECT id,mode FROM terminal_tabs WHERE task_id=? ORDER BY id')
      .all('task')
    await f.restartComputer()
    const after = f.services()
    await after.recoverComputer('pc')
    expect(
      f.db.prepare('SELECT id,mode FROM terminal_tabs WHERE task_id=? ORDER BY id').all('task')
    ).toEqual(tabs)
  } finally {
    await f.close()
  }
})

// Keep this real hub/computer storage recovery integration: mocks cannot prove persisted ownership, activation and content survive reopening together. Operations are awaited and fixtures are isolated. A rare outer watchdog timeout under deliberately oversubscribed host load is acceptable as an infrastructure signal; investigate isolated failure before declaring a storage regression.
test('audit: interrupted activation also blocks native stop through global command barrier', async () => {
  const f = await fixture()
  try {
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    f.db
      .prepare(
        "INSERT INTO chat_tab_state(tab_id,draft_text,updated_at) VALUES('tab','preserve draft',123)"
      )
      .run()
    const before = f.services()
    f.failActivation()
    await expect(before.relay.ops.getTabState('tab')).rejects.toThrow(
      'Disconnected before migration activation'
    )
    await f.restartComputer()
    const after = f.services()
    const barrier = createComputerChatCommandBarrier({ lifecycle: after.lifecycle.syncNative })
    await expect(barrier('pc', 'pty.kill')).resolves.toBeUndefined()
  } finally {
    await f.close()
  }
})

// Keep this real hub/computer storage recovery integration: mocks cannot prove persisted ownership, activation and content survive reopening together. Operations are awaited and fixtures are isolated. A rare outer watchdog timeout under deliberately oversubscribed host load is acceptable as an infrastructure signal; investigate isolated failure before declaring a storage regression.
test('audit: local hook inbox preserves prompts from multiple native provider modes', async () => {
  const f = await fixture()
  try {
    const hub = f.services()
    await hub.captureHook(
      {
        agentId: 'codex',
        mode: 'codex',
        hookEvent: 'UserPromptSubmit',
        taskId: 'task',
        sessionId: 'codex-native',
        raw: { prompt: 'codex prompt' }
      },
      'pc'
    )
    await expect(
      hub.captureHook(
        {
          agentId: 'claude-code',
          mode: 'claude-code',
          hookEvent: 'UserPromptSubmit',
          taskId: 'task',
          sessionId: 'claude-native',
          raw: { prompt: 'claude prompt' }
        },
        'pc'
      )
    ).resolves.toBeUndefined()
    expect((await hub.prompts('task')).map((p) => p.text).sort()).toEqual([
      'claude prompt',
      'codex prompt'
    ])
  } finally {
    await f.close()
  }
})

// Keep this real hub/computer storage recovery integration: mocks cannot prove persisted ownership, activation and content survive reopening together. Operations are awaited and fixtures are isolated. A rare outer watchdog timeout under deliberately oversubscribed host load is acceptable as an infrastructure signal; investigate isolated failure before declaring a storage regression.
test('audit: interrupted activation must not disable a different healthy task on same computer', async () => {
  const f = await fixture()
  try {
    f.db
      .prepare(
        "INSERT INTO tasks(id,project_id,title,worktree_path) SELECT 'other-task',project_id,'Other Task',worktree_path FROM tasks WHERE id='task'"
      )
      .run()
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('other-tab','other-task','codex-chat',0)"
      )
      .run()
    const before = f.services()
    await before.relay.ops.saveTabDraft('other-tab', { text: 'healthy task', attachments: [] })
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    f.db
      .prepare(
        "INSERT INTO chat_tab_state(tab_id,draft_text,updated_at) VALUES('tab','preserve draft',123)"
      )
      .run()
    f.failActivation()
    await expect(before.relay.ops.getTabState('tab')).rejects.toThrow(
      'Disconnected before migration activation'
    )
    await f.restartComputer()
    const after = f.services()
    await expect(after.relay.ops.getTabState('other-tab')).resolves.toMatchObject({
      draft: { text: 'healthy task' }
    })
  } finally {
    await f.close()
  }
})

// Keep this real hub/computer storage recovery integration: mocks cannot prove persisted ownership, activation and content survive reopening together. Operations are awaited and fixtures are isolated. A rare outer watchdog timeout under deliberately oversubscribed host load is acceptable as an infrastructure signal; investigate isolated failure before declaring a storage regression.
test('audit control: resuming committed migration before metadata recovery preserves content', async () => {
  const f = await fixture()
  try {
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    f.db
      .prepare(
        "INSERT INTO chat_tab_state(tab_id,draft_text,rev,updated_at) VALUES('tab','preserve draft',3,123)"
      )
      .run()
    const before = f.services()
    f.failActivation()
    await expect(before.relay.ops.getTabState('tab')).rejects.toThrow(
      'Disconnected before migration activation'
    )
    const owner = (await before.ownership.forTab('tab'))!
    expect(f.db.prepare("SELECT draft_text FROM chat_tab_state WHERE tab_id='tab'").get()).toEqual({
      draft_text: 'preserve draft'
    })
    await f.restartComputer()
    const after = f.services()
    await after.migration.ensure(owner.id, 'pc')
    await after.recoverComputer('pc')
    expect(await after.relay.ops.getTabState('tab')).toMatchObject({
      draft: { text: 'preserve draft', rev: 3 }
    })
    expect(await after.ownership.forTab('tab')).toMatchObject({ epoch: 2, cleanupPending: false })
    expect(f.db.prepare("SELECT 1 FROM chat_tab_state WHERE tab_id='tab'").get()).toBeUndefined()
  } finally {
    await f.close()
  }
})

// Keep this real hub/computer storage recovery integration: mocks cannot prove persisted ownership, activation and content survive reopening together. Operations are awaited and fixtures are isolated. A rare outer watchdog timeout under deliberately oversubscribed host load is acceptable as an infrastructure signal; investigate isolated failure before declaring a storage regression.
test('audit control: re-enrollment with a new computer identity cannot appropriate old ownership', async () => {
  const f = await fixture()
  try {
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    const before = f.services()
    await before.relay.ops.saveTabDraft('tab', { text: 'original computer draft', attachments: [] })
    const original = await before.ownership.forTab('tab')
    await f.restartComputer()
    const after = f.services('new-computer-id')
    await expect(after.recoverComputer('new-computer-id')).rejects.toThrow(
      'Chat tab has another active owner'
    )
    expect(await after.ownership.forTab('tab')).toMatchObject({
      id: original!.id,
      computerId: 'pc',
      epoch: original!.epoch
    })
  } finally {
    await f.close()
  }
})

/**
 * Every statement on chat storage that reads `records`, as it runs during `run`: its
 * SQL, its parameters, the database it ran on and how many rows reached JavaScript.
 * The computer runtime runs in this process, so its better-sqlite3 handle is seen here.
 */
async function recordsReads(run: () => Promise<unknown>) {
  const proto = Database.prototype as unknown as {
    prepare(this: Database.Database, sql: string): Database.Statement
  }
  const realPrepare = proto.prepare
  const realParse = JSON.parse
  const reads: Array<{ sql: string; params: unknown[]; db: Database.Database; rows: number }> = []
  const parsed: number[] = []
  proto.prepare = function (sql) {
    const stmt = realPrepare.call(this, sql)
    if (/\bFROM records\b/.test(sql)) {
      const all = stmt.all.bind(stmt)
      const db = this
      stmt.all = ((...params: unknown[]) => {
        const rows = all(...params) as unknown[]
        reads.push({ sql, params, db, rows: rows.length })
        return rows
      }) as typeof stmt.all
    }
    return stmt
  }
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    parsed.push(typeof text === 'string' ? text.length : 0)
    return realParse(text, reviver)
  }) as typeof JSON.parse
  let result: unknown
  try {
    result = await run()
  } finally {
    proto.prepare = realPrepare
    JSON.parse = realParse
  }
  return {
    result,
    reads: reads.map((read) => ({
      ...read,
      /** How SQLite visits `records` for it (EXPLAIN QUERY PLAN, same parameters). */
      plan: (
        realPrepare.call(read.db, `EXPLAIN QUERY PLAN ${read.sql}`).all(...read.params) as Array<{
          detail: string
        }>
      ).map((row) => row.detail)
    })),
    /** Lengths of every string JSON.parse was handed. */
    parsed
  }
}

test('audit measurement: pending metadata reads scale with retained diagnostic payload', async () => {
  const f = await fixture()
  let raw: ReturnType<typeof openChatStorage> | undefined
  try {
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    const hub = f.services()
    await hub.relay.ops.saveTabDraft('tab', { text: 'draft', attachments: [] })
    const owner = (await hub.ownership.forTab('tab'))!
    raw = openChatStorage({ stateDir: f.dir, hubScope: 'hub' })
    const pending = [0, 1, 2].map((n) => ({ sequence: n, audit: `pending-${n}` }))
    raw.transaction(() => {
      for (const value of pending)
        raw!.putRecord(owner.id, owner.epoch, {
          kind: 'settings',
          id: `metadata:audit-${value.sequence}`,
          value,
          at: value.sequence
        })
    })
    const pendingMetadata = () => f.request({ kind: 'pendingMetadata' })
    const baseline = await recordsReads(pendingMetadata)
    expect(baseline.result, 'the pending metadata').toEqual(pending)

    // 32 MiB of retained diagnostics beside it.
    const payload = 'x'.repeat(128 * 1024)
    raw.transaction(() => {
      for (let n = 0; n < 256; n++)
        raw!.putRecord(owner.id, owner.epoch, {
          kind: 'settings',
          id: `diagnostic:audit-${n}`,
          value: { payload },
          at: n
        })
    })
    const retained = await recordsReads(pendingMetadata)
    expect(retained.result, 'the same pending metadata').toEqual(pending)

    expect(retained.reads.length, 'the read goes through chat storage').toBeGreaterThan(0)
    // The same statements, the same rows reaching JavaScript: none of the diagnostics.
    expect(
      retained.reads.map((read) => [read.sql, read.rows]),
      'what is read does not grow with retained diagnostics'
    ).toEqual(baseline.reads.map((read) => [read.sql, read.rows]))
    expect(
      retained.reads.reduce((sum, read) => sum + read.rows, 0),
      'only the pending metadata rows are read'
    ).toEqual(pending.length)
    // SQLite never walks the records table: it seeks the metadata id range, so a
    // diagnostic row (payload included) is never visited.
    for (const read of retained.reads) {
      const visits = read.plan.filter((detail) => /\b(records|r)\b/.test(detail))
      expect(visits.length, `records visited in: ${read.plan.join(' | ')}`).toBeGreaterThan(0)
      for (const detail of visits)
        expect(detail, 'an indexed id-range seek, never a scan').toMatch(
          /^SEARCH .*\bid>\? AND id<\?/
        )
    }
    expect(
      retained.parsed.filter((length) => length >= payload.length),
      'no diagnostic payload is deserialized'
    ).toEqual([])
  } finally {
    raw?.close()
    await f.close()
  }
})

// Keep this real hub/computer storage recovery integration: mocks cannot prove persisted ownership, activation and content survive reopening together. Operations are awaited and fixtures are isolated. A rare outer watchdog timeout under deliberately oversubscribed host load is acceptable as an infrastructure signal; investigate isolated failure before declaring a storage regression.
// (Applies to both cases: content=false and content=true.)
test.each([false, true])(
  'recovery repairs only empty generated prompt tabs, later chat content=%s',
  async (hasActivity) => {
    const f = await fixture()
    try {
      f.db
        .prepare(
          "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('native-tab','task','codex',0)"
        )
        .run()
      f.db
        .prepare(
          "INSERT INTO agent_prompts(id,task_id,agent_id,text,created_at) VALUES('prompt','task','codex','preserved prompt',123)"
        )
        .run()
      const before = f.services()
      expect(await before.prompts('task', 'codex')).toMatchObject([{ text: 'preserved prompt' }])
      // Reproduce the UI row made by older reconnect code without altering ownership.
      f.db
        .prepare(
          "INSERT INTO terminal_tabs(id,task_id,label,mode,position) VALUES('prompt-history:task','task','Chat','claude-chat',1)"
        )
        .run()
      if (hasActivity)
        await before.relay.ops.saveTabDraft('prompt-history:task', {
          text: 'user kept this chat',
          attachments: []
        })
      await f.restartComputer()
      const after = f.services()
      await after.recoverComputer('pc')
      const visible = f.db
        .prepare("SELECT id FROM terminal_tabs WHERE id='prompt-history:task'")
        .get()
      if (hasActivity) {
        expect(visible).toEqual({ id: 'prompt-history:task' })
        expect(await after.relay.ops.getTabState('prompt-history:task')).toMatchObject({
          draft: { text: 'user kept this chat' }
        })
      } else expect(visible).toBeUndefined()
      expect(await after.ownership.forTab('task-content:task')).toMatchObject({
        state: 'active',
        cleanupPending: false
      })
      if (hasActivity)
        expect(await after.ownership.forTab('prompt-history:task')).toMatchObject({
          state: 'active'
        })
      else expect(await after.ownership.forTab('prompt-history:task')).toBeNull()
      expect(await after.prompts('task', 'codex')).toMatchObject([{ text: 'preserved prompt' }])
    } finally {
      await f.close()
    }
  }
)

// Keep this real hub/computer storage recovery integration: mocks cannot prove persisted ownership, activation and content survive reopening together. Operations are awaited and fixtures are isolated. A rare outer watchdog timeout under deliberately oversubscribed host load is acceptable as an infrastructure signal; investigate isolated failure before declaring a storage regression.
// (Applies to both cases: later chat=false and later chat=true.)
test.each([false, true])(
  'recovery preserves genuine pre-fix prompt ownership while repairing phantom row, later chat=%s',
  async (hasActivity) => {
    const f = await fixture()
    try {
      f.db
        .prepare(
          "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('native-tab','task','codex',0)"
        )
        .run()
      f.db
        .prepare(
          "INSERT INTO agent_prompts(id,task_id,agent_id,text,created_at) VALUES('prompt','task','codex','preserved pre-fix prompt',123)"
        )
        .run()
      const before = f.services()
      // Recreate a real pre-fix storage identity, before the independent task
      // authority existed, using the real source/transfer/activation path.
      await before.ownership.register({
        id: 'pre-fix-prompt-owner',
        taskId: 'task',
        tabId: 'prompt-history:task',
        mode: 'claude-chat',
        computerId: null,
        epoch: 1
      })
      await before.migration.ensure('pre-fix-prompt-owner', 'pc')
      expect(await before.prompts('task', 'codex')).toMatchObject([
        { text: 'preserved pre-fix prompt' }
      ])
      f.db
        .prepare(
          "INSERT INTO terminal_tabs(id,task_id,label,mode,position) VALUES('prompt-history:task','task','Chat','claude-chat',1)"
        )
        .run()
      if (hasActivity)
        await before.relay.ops.saveTabDraft('prompt-history:task', {
          text: 'retained pre-fix chat draft',
          attachments: []
        })
      await f.restartComputer()
      const after = f.services()
      await after.recoverComputer('pc')
      const tab = f.db.prepare("SELECT id FROM terminal_tabs WHERE id='prompt-history:task'").get()
      if (hasActivity) {
        expect(tab).toEqual({ id: 'prompt-history:task' })
        expect(await after.relay.ops.getTabState('prompt-history:task')).toMatchObject({
          draft: { text: 'retained pre-fix chat draft' }
        })
      } else expect(tab).toBeUndefined()
      expect(await after.ownership.forTab('prompt-history:task')).toMatchObject({
        id: 'pre-fix-prompt-owner',
        state: 'active',
        cleanupPending: false
      })
      expect(await after.prompts('task', 'codex')).toMatchObject([
        { text: 'preserved pre-fix prompt' }
      ])
    } finally {
      await f.close()
    }
  }
)

test('a delayed bootstrap cannot mint a newer revision for configuration captured before an edit', async () => {
  // Every provider start, as the computer launches it (the real spawn: the fake CLI
  // still runs). Awaiting the first one is the event, not a poll of the fake's log.
  const providerStarts: Array<{ model: string | undefined; pid: number | undefined }> = []
  let providerStarted!: () => void
  const firstProviderStart = new Promise<void>((resolve) => {
    providerStarted = resolve
  })
  const recordingSpawn = ((file: string, args: readonly string[], options: object) => {
    const child = spawn(file, args, options)
    if (basename(file) === 'claude') {
      const at = args.indexOf('--model')
      providerStarts.push({ model: at >= 0 ? args[at + 1] : undefined, pid: child.pid })
      providerStarted()
    }
    return child
  }) as typeof spawn
  const f = await fixture({ spawnProcess: recordingSpawn })
  try {
    f.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    f.db
      .prepare("UPDATE tasks SET provider_config=? WHERE id='task'")
      .run(JSON.stringify({ 'claude-chat': { chatModel: 'sonnet' } }))
    // The tab has no hydrated session, so the edit takes setModel's
    // kill+respawn path: the provider is started with the edited model.
    f.fakeClaude.setScenario({ processes: [{ defaultTurn: echoTurn() }] })
    const before = f.services()
    await before.relay.ops.getTabState('tab')
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>((resolve) => {
        release = resolve
      }),
      ready = new Promise<void>((resolve) => {
        entered = resolve
      })
    const delayed = f.services('pc', async () => {
      entered()
      await blocked
      return {}
    })
    const opening = delayed.relay.ops.getTabState('tab')
    try {
      // Released in `finally` whatever fails here, so the blocked opening never hangs.
      await Promise.race([
        ready,
        opening.then(() => {
          throw new Error('the delayed bootstrap opened without reaching buildMcpEnv')
        })
      ])
      await before.relay.ops.setModel({
        tabId: 'tab',
        taskId: 'task',
        mode: 'claude-chat',
        cwd: f.dir,
        chatModel: 'opus'
      })
    } finally {
      release()
      await opening
    }
    const owner = (await before.ownership.forTab('tab'))!
    expect(
      await f.request({
        kind: 'invoke',
        value: {
          route: { id: owner.id, epoch: owner.epoch },
          target: 'ops',
          method: 'getModel',
          args: ['task', 'claude-chat']
        }
      })
    ).toBe('opus')
    await firstProviderStart
    expect(providerStarts.map((start) => start.model)).toEqual(['opus'])
    expect(providerStarts[0]?.pid, 'the provider really launched').toBeTypeOf('number')
    expect(
      JSON.parse(
        (
          f.db.prepare("SELECT provider_config FROM tasks WHERE id='task'").get() as {
            provider_config: string
          }
        ).provider_config
      )['claude-chat'].chatModel
    ).toBe('opus')
  } finally {
    await f.close()
  }
})
