import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness'
import { createLegacyChatDiagnostics, createDiagnosticTaskResolver } from './chat-diagnostics'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('owner resolver requires consistent exact task, tab and provider-session evidence', async () => {
  const raw = new Database(':memory:')
  try {
    raw.exec(
      "CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES('a'),('b'); CREATE TABLE chat_task_lifecycle(task_id TEXT,state TEXT); INSERT INTO chat_task_lifecycle VALUES('deleted','deleted'); CREATE TABLE terminal_tabs(id TEXT,task_id TEXT); INSERT INTO terminal_tabs VALUES('tab','a'); CREATE TABLE agent_sessions(id TEXT,conversation_id TEXT,task_id TEXT); INSERT INTO agent_sessions VALUES('s','thread','a'),('s2','shared','a'),('s3','shared','b')"
    )
    const resolve = createDiagnosticTaskResolver(createSlayzoneDbAdapter(raw))
    expect(await resolve({ taskIds: [], tabIds: ['tab'], sessionIds: ['thread'] })).toBe('a')
    expect(await resolve({ taskIds: ['b'], tabIds: ['tab'], sessionIds: [] })).toBeNull()
    expect(await resolve({ taskIds: ['missing'], tabIds: ['tab'], sessionIds: [] })).toBeNull()
    expect(await resolve({ taskIds: [], tabIds: [], sessionIds: ['shared'] })).toBeNull()
    expect(await resolve({ taskIds: ['deleted'], tabIds: [], sessionIds: [] })).toBe('deleted')
    expect(await resolve({ taskIds: [], tabIds: [], sessionIds: [] })).toBeNull()
  } finally {
    raw.close()
  }
})

test('shared screenshot stays held until every owning task has a verified copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-diagnostic-holds-')),
    raw = new Database(':memory:'),
    image = join(dir, 'shared.png')
  try {
    writeFileSync(image, 'private screenshot')
    raw.exec(
      'CREATE TABLE diagnostics_events(id TEXT PRIMARY KEY,task_id TEXT,event TEXT,message TEXT,payload_json TEXT,ts_ms INTEGER)'
    )
    const insert = raw.prepare('INSERT INTO diagnostics_events VALUES(?,?,?,?,?,?)')
    for (const task of ['a', 'b'])
      insert.run(
        task,
        task,
        'renderer.chat.canary',
        'private',
        JSON.stringify({ screenshotDataUrl: image }),
        1
      )
    const source = createLegacyChatDiagnostics({ db: createSlayzoneDbAdapter(raw), blobDir: dir })
    expect(await source.tasks()).toEqual(['a', 'b'])
    for (const task of ['a', 'b']) {
      const cutoff = await source.freeze(task),
        rows = []
      for await (const row of source.records(task, cutoff)) rows.push(row)
      expect(JSON.stringify(rows)).toContain(Buffer.from('private screenshot').toString('base64'))
      await source.cleanup(task, cutoff)
      expect(existsSync(image)).toBe(task === 'a')
    }
  } finally {
    raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy context attribution controls copying, fences and cleanup without guessing missing owners', async () => {
  const raw = new Database(':memory:')
  try {
    raw.exec(
      'CREATE TABLE diagnostics_events(id TEXT PRIMARY KEY,task_id TEXT,event TEXT,message TEXT,payload_json TEXT,ts_ms INTEGER)'
    )
    const insert = raw.prepare('INSERT INTO diagnostics_events VALUES(?,?,?,?,?,?)')
    insert.run(
      'context',
      null,
      'renderer.error-boundary',
      'private error',
      JSON.stringify({ snapshot: { activeTaskId: 't' } }),
      1
    )
    insert.run('tab', null, 'chat.error', 'private tab', JSON.stringify({ tabId: 'tab' }), 2)
    insert.run('unknown', null, 'renderer.window.error', 'private orphan', '{}', 3)
    insert.run(
      'conflict',
      'other',
      'chat.error',
      'private conflict',
      JSON.stringify({ taskId: 't' }),
      4
    )
    const source = createLegacyChatDiagnostics({
      db: createSlayzoneDbAdapter(raw),
      resolveTask: async (evidence) => {
        const tasks = new Set(evidence.taskIds)
        if (evidence.tabIds.includes('tab')) tasks.add('t')
        return tasks.size === 1 ? [...tasks][0] : null
      }
    })
    expect(await source.tasks()).toEqual(['t'])
    expect(await source.unassigned()).toBe(2)
    expect(() => raw.exec("DELETE FROM diagnostics_events WHERE id='unknown'")).toThrow(
      /migration/i
    )
    const cutoff = await source.freeze('t')
    expect(() => raw.exec("UPDATE diagnostics_events SET message='' WHERE id='tab'")).toThrow(
      /migration/i
    )
    const records = []
    for await (const record of source.records('t', cutoff)) records.push(record)
    expect(records.map((record) => record.id)).toEqual(['diagnostic:context', 'diagnostic:tab'])
    await source.cleanup('t', cutoff)
    expect(await source.tasks()).toEqual([])
    expect(await source.unassigned()).toBe(2)
    expect(raw.prepare("SELECT message FROM diagnostics_events WHERE id='unknown'").get()).toEqual({
      message: 'private orphan'
    })
    expect(raw.prepare("SELECT message FROM diagnostics_events WHERE id='tab'").get()).toEqual({
      message: ''
    })
  } finally {
    raw.close()
  }
})

test('diagnostic migration fences retention until copied; cleanup keeps metadata only', async () => {
  const raw = new Database(':memory:')
  try {
    raw.exec(
      'CREATE TABLE diagnostics_events(id TEXT PRIMARY KEY,task_id TEXT,event TEXT,message TEXT,payload_json TEXT,ts_ms INTEGER)'
    )
    raw
      .prepare('INSERT INTO diagnostics_events VALUES(?,?,?,?,?,?)')
      .run(
        'd',
        't',
        'pty.hook_received',
        'private prompt',
        JSON.stringify({ raw: { prompt: 'private marker' } }),
        123
      )
    const source = createLegacyChatDiagnostics({ db: createSlayzoneDbAdapter(raw) })
    const cutoff = await source.freeze('t'),
      records = []
    expect(() => raw.exec('DELETE FROM diagnostics_events')).toThrow(/migration/i)
    for await (const r of source.records('t', cutoff)) records.push(r)
    expect(records).toMatchObject([
      {
        id: 'diagnostic:d',
        value: {
          message: 'private prompt',
          payload_json: expect.stringContaining('private marker')
        }
      }
    ])
    await source.cleanup('t', cutoff)
    expect(raw.prepare('SELECT event,message,payload_json FROM diagnostics_events').get()).toEqual({
      event: 'pty.hook_received',
      message: '',
      payload_json: null
    })
    expect(() => raw.exec('DELETE FROM diagnostics_events')).not.toThrow()
  } finally {
    raw.close()
  }
})

test('post-cutover metadata does not make new tabs look like legacy content', async () => {
  const raw = new Database(':memory:')
  try {
    raw.exec(
      'CREATE TABLE diagnostics_events(id TEXT PRIMARY KEY,task_id TEXT,event TEXT,message TEXT,payload_json TEXT,ts_ms INTEGER)'
    )
    const source = createLegacyChatDiagnostics({ db: createSlayzoneDbAdapter(raw) })
    await source.tasks()
    raw
      .prepare('INSERT INTO diagnostics_events VALUES(?,?,?,?,?,?)')
      .run('new', 'new-task', 'renderer.chat.inFlight.flip', 'state only', '{}', Date.now() + 1000)
    expect(await source.hasTask('new-task')).toBe(false)
    expect(await source.tasks()).toEqual([])
    // A new process must keep the original cutoff, even for backdated metadata.
    raw
      .prepare('INSERT INTO diagnostics_events VALUES(?,?,?,?,?,?)')
      .run('backdated', 'new-task', 'renderer.chat.inFlight.flip', 'state only', '{}', 1)
    const reopened = createLegacyChatDiagnostics({ db: createSlayzoneDbAdapter(raw) })
    expect(await reopened.tasks()).toEqual([])
  } finally {
    raw.close()
  }
})

test('compaction and row ID reuse cannot turn new diagnostics into legacy history', async () => {
  const raw = new Database(':memory:')
  try {
    raw.exec(
      'CREATE TABLE diagnostics_events(id TEXT PRIMARY KEY,task_id TEXT,event TEXT,message TEXT,payload_json TEXT,ts_ms INTEGER)'
    )
    raw
      .prepare('INSERT INTO diagnostics_events VALUES(?,?,?,?,?,?)')
      .run('old', 'old-task', 'chat.old', 'private old history', '{}', 1)
    const source = createLegacyChatDiagnostics({ db: createSlayzoneDbAdapter(raw) })
    expect(await source.tasks()).toEqual(['old-task'])
    await source.cleanup('old-task', await source.freeze('old-task'))
    raw.exec('DELETE FROM diagnostics_events; VACUUM')
    raw
      .prepare('INSERT INTO diagnostics_events VALUES(?,?,?,?,?,?)')
      .run('fresh', 'fresh-task', 'renderer.chat.inFlight.flip', 'state only', '{}', 1)
    expect(await source.hasTask('fresh-task')).toBe(false)
    expect(await source.tasks()).toEqual([])
  } finally {
    raw.close()
  }
})

test('unresolvable legacy rows are attributed once per process, not on every query', async () => {
  // Every relay lookup (hasTask/tasks/freeze) used to re-run the whole attribution
  // pass over rows that can never resolve — a long synchronous block on the hub
  // thread per call, enough to time out every task tab on a renderer reload.
  const raw = new Database(':memory:')
  try {
    raw.exec(
      'CREATE TABLE diagnostics_events(id TEXT PRIMARY KEY,task_id TEXT,event TEXT,message TEXT,payload_json TEXT,ts_ms INTEGER)'
    )
    const insert = raw.prepare('INSERT INTO diagnostics_events VALUES(?,?,?,?,?,?)')
    for (let i = 0; i < 300; i++)
      insert.run(`orphan-${i}`, null, 'renderer.window.error', 'private', '{}', i)
    insert.run('owned', 't', 'chat.error', 'private', '{}', 1000)
    let calls = 0
    const resolveTask = async (evidence: { taskIds: string[] }) => {
      calls++
      return evidence.taskIds.length === 1 ? evidence.taskIds[0] : null
    }
    const source = createLegacyChatDiagnostics({ db: createSlayzoneDbAdapter(raw), resolveTask })
    expect(await source.tasks()).toEqual(['t'])
    expect(calls).toBe(301)
    expect(await source.hasTask('t')).toBe(true)
    expect(await source.hasTask('other')).toBe(false)
    expect(await source.unassigned()).toBe(300)
    await source.freeze('t')
    expect(calls).toBe(301)
    // A new process (hub restart) gets one fresh attempt — owners that appeared
    // since can still be found.
    const reopened = createLegacyChatDiagnostics({ db: createSlayzoneDbAdapter(raw), resolveTask })
    expect(await reopened.unassigned()).toBe(300)
    expect(calls).toBe(601)
  } finally {
    raw.close()
  }
})

test('a failed attribution pass is retried by the next caller', async () => {
  const raw = new Database(':memory:')
  try {
    raw.exec(
      'CREATE TABLE diagnostics_events(id TEXT PRIMARY KEY,task_id TEXT,event TEXT,message TEXT,payload_json TEXT,ts_ms INTEGER)'
    )
    raw
      .prepare('INSERT INTO diagnostics_events VALUES(?,?,?,?,?,?)')
      .run('owned', 't', 'chat.error', 'private', '{}', 1)
    let fail = true
    const source = createLegacyChatDiagnostics({
      db: createSlayzoneDbAdapter(raw),
      resolveTask: async (evidence) => {
        if (fail) throw new Error('main DB busy')
        return evidence.taskIds[0] ?? null
      }
    })
    await expect(source.tasks()).rejects.toThrow('main DB busy')
    fail = false
    expect(await source.tasks()).toEqual(['t'])
  } finally {
    raw.close()
  }
})
