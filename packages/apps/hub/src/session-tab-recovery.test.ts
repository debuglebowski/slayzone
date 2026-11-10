/**
 * One-time recovery of secondary-tab terminal sessions after v201 (robustness
 * plan §2, decision 1). The fixture is the 2026-11-09 incident, rows and
 * diagnostics copied from the dev store: task ad79481c, secondary tab "deploy"
 * (b6766114) minted bf71421e at 21:17:03, resumed it at 22:40:50; the main
 * agent's mode switch at 23:02:24 reset claude-code for the whole task, so the
 * deploy tab minted 786b528e at 23:12:41.
 *
 * Required outcome: the deploy tab resumes bf71421e — 786b528e is never its
 * current session, also not once it takes a turn — and the main tab is reset.
 *
 * The sessions are on the computer (robustness plan §9): the recovery runs there,
 * against an in-process computer ledger, with the evidence and work list on the hub.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/hub/src/session-tab-recovery.test.ts
 */
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import type { DiagnosticEvent } from '@slayzone/diagnostics/shared'
import { createSessionLedgerHarness } from '@slayzone/chat-runtime/server'
import { createSlayzoneDbAdapter, createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { recoverTaskSessionTabs } from './session-tab-recovery'

const T = 'ad79481c-af57-42c3-9edf-6e298f2edad3'
const DEPLOY = 'b6766114-b3e8-444d-b763-1b23d77a881c'
const BF = 'bf71421e-cb76-48b9-bffa-f117f739155c'
const CASUALTY = '786b528e-b889-4596-ab0e-1fda13389b50'
const M = 'claude-code'
const BACKFILLED_AT = 1794263000000 // the v201 migration, after the incident

async function incident(
  opts: { diagnostics: boolean; deployEvidence?: boolean } = { diagnostics: true }
) {
  const h = await createTestHarness()
  const db = h.db
  db.prepare("INSERT INTO projects(id,name,color) VALUES('p','P','#000')").run()
  db.prepare("INSERT INTO tasks(id,project_id,title,agent_id) VALUES(?,'p','Deploy',?)").run(T, M)
  db.prepare(
    `INSERT INTO terminal_tabs (id, task_id, label, mode, is_main, position, group_id, created_at)
     VALUES (?, ?, NULL, ?, 1, 0, ?, '2026-11-09'), (?, ?, 'deploy', ?, 0, 1, ?, '2026-11-09')`
  ).run(T, T, M, T, DEPLOY, T, M, DEPLOY)
  // As v201 left them (and v206 handed them to the computer): every row backfilled
  // to the MAIN tab.
  const computer = createSessionLedgerHarness({ db: h.slayDb })
  const session = (...args: unknown[]) =>
    computer.storage.compose((raw) =>
      raw
        .prepare(
          `INSERT INTO agent_sessions (id, mode, task_id, tab_id, conversation_id, origin, status, pending_meta, created_at, bound_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(...(args as never[]))
    )
  const rows: Array<[string, number, string, string, string]> = [
    ['6504f716', 1794255423583, BF, 'pending-spawn', 'bound'],
    ['d36c72b9', 1794255424126, BF, 'slay-spawned-fresh', 'dead'],
    ['ff24ffce', 1794260450077, BF, 'pending-spawn', 'bound'],
    ['7b46b8be', 1794260450824, BF, 'slay-spawned-resume', 'dead'],
    ['9b8901ab', 1794262361658, CASUALTY, 'pending-spawn', 'bound'],
    ['d94ff1a1', 1794262362228, CASUALTY, 'slay-spawned-fresh', 'dead']
  ]
  for (const [id, at, conv, origin, status] of rows)
    session(id, M, T, T, conv, origin, status, null, at, at)
  computer.storage.compose((raw) =>
    raw
      .prepare('INSERT INTO session_turns (conversation_id, first_turn_at) VALUES (?, ?)')
      .run(BF, 1794255472142)
  )
  // The main agent's mode switch: a reset now scoped to the MAIN tab.
  db.prepare(
    'INSERT INTO session_resets (id, task_id, mode, tab_id, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run('5a7231c8', T, M, T, 1794261744758)
  const queue = db.prepare(
    'INSERT INTO session_tab_recovery (task_id, mode, conversation_id, backfilled_at) VALUES (?, ?, ?, ?)'
  )
  for (const conv of [BF, CASUALTY]) queue.run(T, M, conv, BACKFILLED_AT)

  const diag = new Database(':memory:')
  diag.exec(`CREATE TABLE diagnostics_events (
    id TEXT PRIMARY KEY, ts_ms INTEGER NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL,
    event TEXT NOT NULL, trace_id TEXT, task_id TEXT, project_id TEXT, session_id TEXT,
    channel TEXT, message TEXT, payload_json TEXT, redaction_version INTEGER NOT NULL DEFAULT 1)`)
  const ev = diag.prepare(
    `INSERT INTO diagnostics_events (id, ts_ms, level, source, event, task_id, session_id, payload_json)
     VALUES (?, ?, 'info', 'pty', ?, ?, ?, ?)`
  )
  let n = 0
  const spawn = (createAt: number, decisionAt: number, resuming: boolean, tab: string) => {
    const sid = `${T}:${tab}`
    ev.run(`e${++n}`, createAt, 'pty.create', T, sid, JSON.stringify({ mode: M, type: M }))
    ev.run(
      `e${++n}`,
      decisionAt,
      'conv_id.spawn_decision',
      T,
      sid,
      JSON.stringify({ hasExisting: false, resuming, shouldMintFresh: false })
    )
  }
  if (opts.deployEvidence !== false) {
    spawn(1794255423221, 1794255423526, false, DEPLOY)
    spawn(1794260450069, 1794260450069, true, DEPLOY)
    spawn(1794262361316, 1794262361617, false, DEPLOY)
  }
  const events: DiagnosticEvent[] = []
  const recover = async () => {
    const result = await recoverTaskSessionTabs(
      {
        db: h.slayDb,
        diagnostics: opts.diagnostics ? createSlayzoneDbAdapter(diag) : null,
        record: (e) => events.push(e),
        ledger: computer.ledger,
        computerId: computer.computerId
      },
      T
    )
    return result ? [result] : []
  }
  const current = (tab: string) =>
    computer.ledger.store.getCurrentConversationId(computer.computerId, T, M, tab)
  const firstTurn = (conversationId: string) =>
    computer.ledger.markSessionFirstTurn(computer.computerId, conversationId)
  const ledgerRows = () =>
    computer.storage.compose((raw) =>
      raw.prepare('SELECT * FROM agent_sessions ORDER BY rowid').all()
    )
  const cleanup = () => {
    computer.close()
    h.cleanup()
  }
  return { h, events, recover, current, firstTurn, ledgerRows, cleanup }
}

test('INCIDENT: the deploy tab resumes bf71421e; 786b528e is never its current session', async () => {
  const { h, events, recover, current, firstTurn, cleanup } = await incident()
  // Before recovery (v201 backfill only): the deploy tab owns nothing.
  expect(await current(DEPLOY)).toBeNull()

  const [result] = await recover()
  expect(result.retagged.map((r) => [r.conversationId, r.tabId]).sort()).toEqual(
    [
      [BF, DEPLOY],
      [CASUALTY, DEPLOY]
    ].sort()
  )
  expect(await current(DEPLOY)).toBe(BF)
  // The main tab stays reset (the mode switch was its own).
  expect(await current(T)).toBeNull()
  // The casualty taking a turn later never takes over: the restore claim is newer.
  await firstTurn(CASUALTY)
  expect(await current(DEPLOY)).toBe(BF)
  expect(events.filter((e) => e.event === 'session.tab_recovered')).toHaveLength(2)
  // Work list settled.
  expect(h.db.prepare('SELECT count(*) AS n FROM session_tab_recovery').get()).toEqual({ n: 0 })
  cleanup()
})

test('restore rule: a casualty that took a turn BEFORE recovery still yields to the tab’s own session', async () => {
  const { h, events, recover, current, firstTurn, cleanup } = await incident()
  await firstTurn(CASUALTY)
  const [result] = await recover()
  expect(result.restored).toEqual([{ mode: M, tabId: DEPLOY, conversationId: BF }])
  expect(await current(DEPLOY)).toBe(BF)
  expect(events.some((e) => e.event === 'session.tab_restored' && e.message === BF)).toBe(true)
  // Nothing deleted: the casualty stays in the history, switchable.
  expect(
    h.db
      .prepare('SELECT count(*) AS n FROM session_deletions WHERE conversation_id = ?')
      .get(CASUALTY)
  ).toEqual({ n: 0 })
  cleanup()
})

test('no evidence: sessions stay on the main tab (the pre-v201 behaviour) and the row settles', async () => {
  const { h, recover, current, cleanup } = await incident({
    diagnostics: true,
    deployEvidence: false
  })
  const [result] = await recover()
  expect(result.retagged).toEqual([])
  expect(await current(DEPLOY)).toBeNull()
  expect(h.db.prepare('SELECT count(*) AS n FROM session_tab_recovery').get()).toEqual({ n: 0 })
  cleanup()
})

test('idempotent: a second run changes nothing', async () => {
  const { recover, ledgerRows, cleanup } = await incident()
  await recover()
  const before = ledgerRows()
  expect(await recover()).toEqual([])
  expect(ledgerRows()).toEqual(before)
  cleanup()
})
