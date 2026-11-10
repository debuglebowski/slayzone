/**
 * Computer-only data handoff (robustness plan §9, P0): the hub delivers the rows it
 * still holds to the computer owning their task, once, and forgets each only after the
 * computer confirmed it. A real hub database against a real computer chat runtime.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAsyncFaultLedger } from '@slayzone/platform/isolation'
import type { DataImportKinds } from '@slayzone/chat-runtime/server'
import { afterEach, expect, test } from 'vitest'
import { z } from 'zod'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { createComputerDataHandoff } from './computer-data-handoff'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

/** The kind a later phase registers for real: keyed rows, the newer `at` wins. */
const probe: DataImportKinds = {
  probe: {
    value: z.object({ text: z.string(), at: z.number() }),
    apply(storage, item) {
      storage.compose((db) => {
        db.exec(
          'CREATE TABLE IF NOT EXISTS probe(key TEXT PRIMARY KEY, task_id TEXT, text TEXT, at INTEGER)'
        )
        db.prepare(
          `INSERT INTO probe VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET text=excluded.text,at=excluded.at
           WHERE excluded.at > probe.at`
        ).run(item.key, item.taskId, item.value.text, item.value.at)
      })
    }
  }
}

function computer(id: string) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), `handoff-${id}-`))
  const pc = createChatRuntimeHandlers({
    stateDir: dir,
    hubScope: 'hub',
    computerId: () => id,
    getProjectPaths: () => null,
    dataImports: probe,
    ctx: {
      config: {
        hubUrl: 'ws://hub/computers',
        name: id,
        allowedRoots: [realpathSync(tmpdir())],
        capabilities: ['proc']
      },
      dialer: { notify: () => true },
      log: () => {}
    }
  } as never)
  cleanups.push(async () => {
    await pc.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { pc }
}

async function fixture() {
  const h = await createTestHarness()
  cleanups.push(() => h.cleanup())
  h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','Project','#000');
    INSERT INTO computers(id,name,platform,version,capabilities_json,created_at) VALUES('pc','pc','linux','1','{}',0),('pc2','pc2','linux','1','{}',0);
    INSERT INTO tasks(id,project_id,title,computer_id) VALUES('t1','p','One','pc'),('t2','p','Two','pc'),('t3','p','Three',NULL);`)
  const pcs = { pc: computer('pc'), pc2: computer('pc2') }
  const online = new Set(['pc', 'pc2'])
  const sent: Array<{ computerId: string; request: { kind: string } }> = []
  let fail: Error | null = null
  const fallback = new Map<string, string>()
  const handoff = createComputerDataHandoff({
    db: h.slayDb,
    request: async (computerId, request) => {
      if (!online.has(computerId)) throw Object.assign(new Error('offline'), { code: 'ECONNRESET' })
      if (fail) throw fail
      sent.push({ computerId, request: request as { kind: string } })
      return pcs[computerId as 'pc' | 'pc2'].pc.request(JSON.parse(JSON.stringify(request)))
    },
    fallbackTarget: async (taskId) => fallback.get(taskId) ?? null,
    ledger: (computerId) => createAsyncFaultLedger(h.slayDb, { origin: 'hub', computerId }),
    isUnreachable: (error) => (error as { code?: string }).code === 'ECONNRESET'
  })
  const stage = (kind: string, key: string, taskId: string, value: unknown) =>
    h.db
      .prepare(
        'INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at) VALUES(?,?,?,?,0)'
      )
      .run(kind, key, taskId, JSON.stringify(value))
  const left = () =>
    h.db.prepare('SELECT kind,item_key FROM computer_data_handoff ORDER BY kind,item_key').all()
  return {
    h,
    pcs,
    online,
    sent,
    handoff,
    stage,
    left,
    fallback,
    failWith: (e: Error | null) => (fail = e)
  }
}

test('a computer connecting receives its tasks’ rows; acked rows are forgotten, others stay', async () => {
  const f = await fixture()
  f.stage('probe', 'a', 't1', { text: 'one', at: 1 })
  f.stage('probe', 'b', 't2', { text: 'two', at: 1 })
  // t3 has no computer yet: it waits.
  f.stage('probe', 'c', 't3', { text: 'three', at: 1 })
  const report = await f.handoff.deliverTo('pc')
  expect(report).toMatchObject({ delivered: 2 })
  expect(f.left()).toEqual([{ kind: 'probe', item_key: 'c' }])
  // The computer that now holds t1's data is one erasure and deletion reach.
  expect(
    f.h.db
      .prepare("SELECT task_id FROM chat_task_computers WHERE computer_id='pc' ORDER BY 1")
      .all()
  ).toEqual([{ task_id: 't1' }, { task_id: 't2' }])
  // Once a placement exists for t3, the next connect delivers it there.
  f.fallback.set('t3', 'pc2')
  await f.handoff.deliverTo('pc')
  expect(f.left()).toEqual([{ kind: 'probe', item_key: 'c' }])
  await f.handoff.deliverTo('pc2')
  expect(f.left()).toEqual([])
})

test('a chat owner wins over the pin; a retired computer hands over to its successor', async () => {
  const f = await fixture()
  f.h.db.exec(`INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','t1','claude-chat',0);
    INSERT INTO chat_ownership(id,task_id,tab_id,mode,state,epoch,computer_id) VALUES('c1','t1','tab','claude-chat','active',1,'old');
    INSERT INTO computer_retirements VALUES('old','pc2','re-enrolled',0);`)
  expect(await f.handoff.target('t1')).toBe('pc2')
  f.h.db.exec("UPDATE computer_retirements SET successor_id=NULL, reason='deleted'")
  expect(await f.handoff.target('t1')).toBe(null)
  f.h.db.exec("DELETE FROM computer_retirements; UPDATE chat_ownership SET computer_id='pc2'")
  expect(await f.handoff.target('t1')).toBe('pc2')
  expect(await f.handoff.target('t2')).toBe('pc')
})

test('flushTask delivers one task now; a lost ack is redelivered without duplicates', async () => {
  const f = await fixture()
  f.stage('probe', 'a', 't1', { text: 'one', at: 1 })
  f.stage('probe', 'b', 't2', { text: 'two', at: 1 })
  // The computer applied it but the hub never heard back (connection dropped).
  await f.pcs.pc.pc.request({
    kind: 'data.import',
    value: { kind: 'probe', items: [{ key: 'a', taskId: 't1', value: { text: 'one', at: 1 } }] }
  })
  await f.handoff.flushTask('t1', 'pc')
  expect(f.left()).toEqual([{ kind: 'probe', item_key: 'b' }])
  expect(f.sent.map((s) => s.request.kind)).toEqual(['data.import'])
  // Nothing staged for t1 any more: no request at all.
  await f.handoff.flushTask('t1', 'pc')
  expect(f.sent).toHaveLength(1)
})

test('flushTask fails while its computer cannot take the rows (a resume must not miss them)', async () => {
  const f = await fixture()
  f.stage('probe', 'a', 't1', { text: 'one', at: 1 })
  f.online.delete('pc')
  await expect(f.handoff.flushTask('t1', 'pc')).rejects.toThrow('offline')
  f.failWith(new Error('disk busy'))
  f.online.add('pc')
  await expect(f.handoff.flushTask('t1', 'pc')).rejects.toThrow('disk busy')
  expect(f.left()).toHaveLength(1)
  f.failWith(null)
  await f.handoff.flushTask('t1', 'pc')
  expect(f.left()).toEqual([])
})

test('an invalid item is quarantined on its own; the rest of its task is delivered', async () => {
  const f = await fixture()
  f.stage('probe', 'good', 't1', { text: 'one', at: 1 })
  f.stage('probe', 'bad', 't1', { text: 42 })
  f.stage('nope', 'x', 't1', {})
  await f.handoff.flushTask('t1', 'pc')
  expect(f.left()).toEqual([
    { kind: 'nope', item_key: 'x' },
    { kind: 'probe', item_key: 'bad' }
  ])
  const faults = f.h.db
    .prepare("SELECT pass,item_key,task_id,kind FROM item_faults WHERE origin='hub' ORDER BY 2")
    .all()
  expect(faults).toEqual([
    { pass: 'hub-data-handoff', item_key: 'nope:x', task_id: 't1', kind: 'structural' },
    { pass: 'hub-data-handoff', item_key: 'probe:bad', task_id: 't1', kind: 'structural' }
  ])
  // Quarantined items are not resent until they change.
  f.sent.length = 0
  await f.handoff.deliverTo('pc')
  expect(f.sent).toEqual([])
  f.h.db.exec(
    `UPDATE computer_data_handoff SET payload='{"text":"fixed","at":2}' WHERE item_key='bad'`
  )
  await f.handoff.deliverTo('pc')
  expect(f.left()).toEqual([{ kind: 'nope', item_key: 'x' }])
})

test('one task failing does not stop the others; an unreachable computer ends the pass', async () => {
  const f = await fixture()
  f.stage('probe', 'a', 't1', { text: 'one', at: 1 })
  f.stage('probe', 'b', 't2', { text: 'two', at: 1 })
  let calls = 0
  f.failWith(null)
  const real = f.pcs.pc.pc.request
  f.pcs.pc.pc.request = async (raw: unknown) => {
    if (++calls === 1) throw new Error('first task breaks')
    return real(raw)
  }
  const report = await f.handoff.deliverTo('pc')
  expect(report).toMatchObject({ delivered: 1, failed: 1 })
  expect(f.left()).toHaveLength(1)
  // t1 now backs off; t2 has a new row: reaching for it finds the computer gone.
  f.stage('probe', 'c', 't2', { text: 'more', at: 2 })
  f.online.delete('pc')
  await expect(f.handoff.deliverTo('pc')).rejects.toThrow('offline')
})

test('rows of a task that no longer exists are dropped, never delivered', async () => {
  const f = await fixture()
  f.stage('probe', 'a', 'purged', { text: 'x', at: 1 })
  await f.handoff.deliverTo('pc')
  expect(f.left()).toEqual([])
  expect(f.sent).toEqual([])
})
