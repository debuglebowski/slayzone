import Database from 'better-sqlite3'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createFakeClaude } from '../../../shared/test-utils/fake-claude'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import {
  notifyTaskPaths,
  resetConversation,
  setTaskPathsDelegate,
  setTaskSessionLedger,
  switchConversation,
  updateTask
} from '@slayzone/task/server'
import { createComputerSessionLedger } from '@slayzone/chat-runtime/hub'
import { taskSessionStore } from './test-session-store'
import { createArtifactStore } from '@slayzone/task-artifacts/server'
import {
  assertTaskMovable,
  deleteComputer,
  registerComputer,
  registerOrReplaceComputer,
  retireStaleLocalComputers
} from '@slayzone/computers/server'
import { checkComputerChatConsistency, checkHubChatConsistency } from '@slayzone/chat-runtime/hub'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'
import { createComputerArtifactStorage } from './computer-artifacts'
import { createItemFaultService } from './item-faults'
import { createComputerDataHandoff } from './computer-data-handoff'
import { settleLegacyChatTablesAtBoot } from './legacy-chat-tables-boot'
import {
  LEGACY_CHAT_TABLES,
  LEGACY_CHAT_TABLES_DROPPED_SETTING,
  legacyChatTablesSync
} from '@slayzone/platform/legacy-chat-tables'
import { createAsyncFaultLedger } from '@slayzone/platform/isolation'
import { isComputerUnreachable } from '@slayzone/chat-runtime/hub'
import {
  type DataImportKinds,
  historyImports,
  sessionLedgerImports,
  taskPathImport
} from '@slayzone/chat-runtime/server'
import {
  createComputerTaskPaths,
  TASK_PATH_KIND,
  recordHolder,
  taskPathTarget
} from './computer-task-paths'
import { z } from 'zod'

/** A computer-only data kind as later phases register them: keyed rows, newer `at` wins. */
const soakData: DataImportKinds = {
  soak: {
    value: z.object({ text: z.string(), at: z.number() }),
    apply(storage, item) {
      storage.compose((db) => {
        db.exec(
          'CREATE TABLE IF NOT EXISTS soak_data(key TEXT PRIMARY KEY, task_id TEXT, text TEXT, at INTEGER)'
        )
        db.prepare(
          `INSERT INTO soak_data VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET text=excluded.text,at=excluded.at
           WHERE excluded.at > soak_data.at`
        ).run(item.key, item.taskId, item.value.text, item.value.at)
      })
    }
  }
}

/**
 * Restart soak: normal user actions, then a restart of hub and computer, over
 * and over. Each step alone is tested elsewhere; this catches what only shows
 * across restarts — state a pass leaves that the NEXT pass re-applies or never
 * clears (a deleted chat re-marked pending forever blocked its task's agents on
 * every restart). After each restart: no consistency rule is violated, and every
 * live task still opens every chat and starts agents.
 */
test('normal use across repeated hub and computer restarts never leaves a task unusable', async () => {
  const h = await createTestHarness()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-soak-'))
  // Any provider spawn resolves `claude` to the scripted fake, never to a real
  // CLI that happens to be on this machine's PATH (CI has none; dev boxes do).
  const fakeClaude = createFakeClaude({ root: join(dir, 'fake-claude') })
  /** The computer's current enrollment id: re-enrolling or deleting it changes it. */
  let pcId = 'pc'
  const openComputer = () =>
    createFixtureChatRuntime({
      stateDir: join(dir, 'pc'),
      hubScope: 'hub',
      computerId: () => pcId,
      getProjectPaths: () => null,
      dataImports: {
        ...sessionLedgerImports,
        ...historyImports,
        'task-path': taskPathImport,
        ...soakData
      },
      ctx: {
        config: {
          hubUrl: 'ws://hub/computers',
          name: 'pc',
          allowedRoots: [realpathSync(tmpdir())],
          capabilities: ['proc'],
          binOverrideDir: fakeClaude.binDir
        },
        dialer: { notify: () => true },
        log: () => {}
      }
    })
  let pc = openComputer()
  /** Whether the computer is connected (it is reached only then). */
  let online = true
  const request = (_id: string, raw: unknown) => {
    if (!online) return Promise.reject(new Error('Computer is offline'))
    return pc.request(JSON.parse(JSON.stringify(raw)))
  }
  /** A fresh hub: no in-memory state survives, as after an app restart. */
  const startHub = () => {
    const chat = createComputerChatServices({
      db: h.slayDb,
      legacyData: {
        ...createDbChatDataOps(h.slayDb, taskSessionStore),
        buildMcpEnv: async () => ({})
      },
      attachments: { read: async () => new Uint8Array() },
      request,
      resolveComputer: async () => pcId,
      defaultComputer: async () => pcId,
      hasLiveTask: async () => false
    })
    const files = createComputerArtifactStorage({
      db: h.slayDb,
      local: createArtifactStore(join(dir, 'hub')),
      chat,
      request
    })
    // Computer-only data the hub still holds goes to the computer on connect (§9).
    const handoff = createComputerDataHandoff({
      db: h.slayDb,
      request: (computerId, raw) => chat.lifecycle.request(computerId, raw),
      track: (taskId, computerId) => chat.lifecycle.track(taskId, computerId),
      ledger: (computerId) => createAsyncFaultLedger(h.slayDb, { origin: 'hub', computerId }),
      isUnreachable: isComputerUnreachable,
      // The hub's default placement: the one computer.
      fallbackTarget: async () => pcId,
      kindTargets: { [TASK_PATH_KIND]: taskPathTarget(h.slayDb) },
      // As composition: the computer a task's paths reached holds its folders (7e).
      delivered: async (kind, taskId, computerId) => {
        if (kind === TASK_PATH_KIND) await recordHolder(h.slayDb, taskId, computerId)
      }
    })
    // A task's worktree path / base dir runs on its computer too (§9, Phase 7a).
    setTaskPathsDelegate(
      createComputerTaskPaths({
        db: h.slayDb,
        targetOf: (kind, taskId) => handoff.targetOf(kind, taskId),
        flushTask: (taskId, computerId) => handoff.flushTask(taskId, computerId),
        usable: () => online,
        request: (computerId, raw) => chat.lifecycle.request(computerId, raw),
        log: () => {}
      })
    )
    // The agent-session ledger lives on the computer (§9): the hub reaches it there.
    const ledger = createComputerSessionLedger({
      db: h.slayDb,
      request: (computerId, raw) => chat.lifecycle.request(computerId, raw),
      target: (taskId) => handoff.target(taskId),
      usable: () => online,
      flushTask: (taskId, computerId) => handoff.flushTask(taskId, computerId),
      track: (taskId, computerId) => chat.lifecycle.track(taskId, computerId)
    })
    setTaskSessionLedger(ledger)
    return { chat, files, handoff, ledger }
  }
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const sql = (s: string, ...params: unknown[]) => h.db.prepare(s).run(...params)
  let tabs = 0
  const addChat = (task: string) => {
    const id = `${task}-chat-${++tabs}`
    sql(
      "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES(?,?,'claude-chat',?)",
      id,
      task,
      tabs
    )
    return id
  }
  try {
    sql("INSERT INTO projects(id,name,color) VALUES('p','P','#000')")
    await registerOrReplaceComputer(h.slayDb, {
      id: 'pc',
      name: 'soak-pc',
      platform: 'darwin',
      version: 'v',
      now: 1
    })
    // Each task's folder as the upgrade (v210/v211) staged it for its computer: the hub
    // keeps only that it has one (§9 7e).
    const stagePath = (task: string, worktreePath: string) => {
      sql('UPDATE tasks SET has_worktree=1 WHERE id=?', task)
      sql(
        `INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at)
         VALUES('task-path',?,?,json_object('projectId','p','worktreePath',?,'baseDir',NULL,'at',0),0)`,
        task,
        task,
        worktreePath
      )
    }
    for (const task of ['a', 'b', 'c', 'd']) {
      sql("INSERT INTO tasks(id,project_id,title) VALUES(?,'p',?)", task, task)
      stagePath(task, dir)
    }
    // The legacy chat tables as an older backup still has them (day 20 brings them back).
    const legacySchema = (
      h.db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name IN (${LEGACY_CHAT_TABLES.map(
            (t) => `'${t}'`
          ).join(',')}) ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`
        )
        .all() as Array<{ sql: string }>
    ).map((r) => r.sql)
    // Hub boot (server.ts): before any service exists.
    const boot = () => settleLegacyChatTablesAtBoot(h.slayDb, () => {})
    await boot()
    let hub = startHub()
    const chats = new Map<string, string[]>()
    const open = async (task: string, tab: string) => {
      await hub.chat.relay.ops.saveTabDraft(tab, { text: tab, attachments: [] })
      chats.set(task, [...(chats.get(task) ?? []), tab])
    }
    const closeChat = (task: string, tab: string) => {
      sql('DELETE FROM terminal_tabs WHERE id=?', tab)
      chats.set(
        task,
        (chats.get(task) ?? []).filter((t) => t !== tab)
      )
    }
    const upload = (task: string, tab: string, title: string) =>
      hub.files.uploadArtifactBlob(h.slayDb, {
        taskId: task,
        title,
        bytes: Buffer.from(title),
        chatTabId: tab
      })

    /** Restart both, then check: rules hold and every live task works. */
    const restartAndCheck = async (round: string) => {
      await pc.close()
      pc = openComputer()
      await boot()
      hub = startHub()
      await hub.chat.recoverComputer(pcId)
      // The reconnect pass's next stage (computer-chat-maintenance): the handoff, then
      // the session intents the computer missed.
      await hub.handoff.deliverTo(pcId)
      await hub.ledger.onComputerConnected(pcId)
      expect(await checkHubChatConsistency(h.slayDb), round).toEqual([])
      expect(await checkComputerChatConsistency(h.slayDb, request, pcId), round).toEqual([])
      const live = h.db
        .prepare('SELECT id FROM tasks WHERE archived_at IS NULL AND deleted_at IS NULL')
        .all() as Array<{ id: string }>
      for (const { id } of live) {
        for (const tab of chats.get(id) ?? [])
          await expect(
            hub.chat.relay.ops.getTabState(tab),
            `${round}: chat ${tab}`
          ).resolves.toMatchObject({ draft: { text: tab } })
        await expect(hub.chat.resolvePtyComputer(id), `${round}: agent in ${id}`).resolves.toBe(
          pcId
        )
      }
      expect(
        warnings.mock.calls.filter((c) => String(c[0]).includes('consistency')),
        round
      ).toEqual([])
    }

    // Day 1: chats, chat uploads, a hub file and folder.
    for (const task of ['a', 'b', 'c', 'd']) await open(task, addChat(task))
    const shot = (await upload('a', chats.get('a')![0], 'shot.png'))!
    await upload('b', chats.get('b')![0], 'log.txt')
    const folder = (await hub.files.createFolder(h.slayDb, { taskId: 'a', name: 'Docs' }))!
    await hub.files.createArtifact(h.slayDb, {
      taskId: 'a',
      title: 'notes.md',
      folderId: folder.id,
      content: 'notes'
    })
    await restartAndCheck('day 1')

    // Day 2: a second chat that is then closed; files moved to another task.
    const extra = addChat('b')
    await open('b', extra)
    closeChat('b', extra)
    await hub.files.moveArtifacts(h.slayDb, {
      artifactIds: [shot.id],
      folderIds: [folder.id],
      sourceTaskId: 'a',
      destTaskId: 'c',
      destFolderId: null
    })
    await restartAndCheck('day 2')

    // Day 3: archive one task, delete a folder, delete a whole task.
    sql("UPDATE tasks SET archived_at=datetime('now') WHERE id='d'")
    await hub.files.deleteFolder(h.slayDb, folder.id)
    sql("DELETE FROM tasks WHERE id='b'")
    chats.delete('b')
    await restartAndCheck('day 3')

    // Day 4: unarchive, more chats and uploads, close the task's last extra chat.
    sql("UPDATE tasks SET archived_at=NULL WHERE id='d'")
    const more = addChat('c')
    await open('c', more)
    await upload('c', more, 'more.txt')
    closeChat('c', more)
    await restartAndCheck('day 4')

    // Days 5-6: restarts with nothing in between (re-applied state must be stable).
    await restartAndCheck('day 5')
    await restartAndCheck('day 6')

    // Day 7: provider change and back, each followed by two restarts. The
    // switched-away chats' records must never delete the tab's live chat.
    const switching = chats.get('a')![0]
    for (const mode of ['codex-chat', 'claude-chat']) {
      sql('UPDATE terminal_tabs SET mode=? WHERE id=?', mode, switching)
      await open('a', switching)
      chats.set('a', [...new Set(chats.get('a'))])
      await restartAndCheck(`day 7 (${mode}, restart 1)`)
      await restartAndCheck(`day 7 (${mode}, restart 2)`)
    }
    // Closing an archived (switched-away) chat: its deletion reaches the
    // computer, whose tombstone then names the live tab's history.
    const archived = h.db
      .prepare("SELECT id FROM terminal_tabs WHERE task_id='a' AND id<>? AND agent_state='stopped'")
      .all(switching) as Array<{ id: string }>
    expect(archived.length).toBeGreaterThan(0)
    for (const { id } of archived) sql('DELETE FROM terminal_tabs WHERE id=?', id)
    await restartAndCheck('day 7 (archived chats closed)')
    await restartAndCheck('day 7 (archived chats closed, again)')

    // Day 8: the machine re-enrolls under a new id; its chat store is the same.
    await registerOrReplaceComputer(h.slayDb, {
      id: 'pc-reenrolled',
      name: 'soak-pc',
      platform: 'darwin',
      version: 'v',
      now: 3
    })
    await retireStaleLocalComputers(h.slayDb, { name: 'soak-pc', keepComputerId: 'pc-reenrolled' })
    pcId = 'pc-reenrolled'
    await restartAndCheck('day 8 (re-enrolled)')
    await restartAndCheck('day 8 (re-enrolled, again)')

    // Day 9: the computer is deleted, then the same machine (same chat data)
    // enrolls as a brand-new computer: it adopts its chats.
    await deleteComputer(h.slayDb, pcId)
    const fresh = await registerComputer(h.slayDb, {
      name: 'soak-pc-new',
      platform: 'darwin',
      version: 'v',
      now: 4
    })
    pcId = fresh.id
    await restartAndCheck('day 9 (computer deleted, machine re-joined)')
    await restartAndCheck('day 9 (again)')

    // Day 10: a task whose only chat never reached a computer is deleted:
    // nothing is left to deliver, so nothing stays pending.
    sql("INSERT INTO tasks(id,project_id,title) VALUES('e','p','e')")
    const legacyTab = addChat('e')
    sql(
      "INSERT INTO chat_ownership(id,task_id,tab_id,mode,epoch,state) VALUES('never-moved','e',?,'claude-chat',1,'legacy')",
      legacyTab
    )
    sql("INSERT INTO chat_tab_bindings(tab_id,conversation_id) VALUES(?,'never-moved')", legacyTab)
    sql("DELETE FROM tasks WHERE id='e'")
    expect(
      h.db.prepare("SELECT state,cleanup_pending FROM chat_ownership WHERE id='never-moved'").get()
    ).toEqual({ state: 'deleted', cleanup_pending: 0 })
    await restartAndCheck('day 10 (zero-target delete)')

    // Day 11: per-tab terminal sessions (v201). A task's main tab and a second
    // claude-code tab each keep their own session through random resets, new
    // sessions and picks of the other tab's sessions — across restarts. The
    // model: what each tab must resume next.
    sql(
      `INSERT INTO terminal_tabs (id, task_id, label, mode, is_main, position, group_id, created_at)
       VALUES ('c', 'c', NULL, 'claude-code', 1, 0, 'c', '2026-11-09'),
              ('c-deploy', 'c', 'deploy', 'claude-code', 0, 9, 'c-deploy', '2026-11-09')
       ON CONFLICT(id) DO NOTHING`
    )
    const M = 'claude-code'
    const tabsOfC = ['c', 'c-deploy'] as const
    const expected = new Map<string, string | null>(tabsOfC.map((t) => [t, null]))
    const owner = new Map<string, string>()
    let seed = 0x2026_1109
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return (seed >>> 16) % n
    }
    const tick = () => new Promise((r) => setTimeout(r, 3))
    const done = { session: 0, reset: 0, pick: 0 }
    for (let step = 0; step < 48; step++) {
      await tick()
      const tab = tabsOfC[rand(2)]
      const other = tabsOfC.find((t) => t !== tab)!
      const action = rand(3)
      if (action === 0) {
        const id = `soak-${step}`
        await hub.ledger.store.recordConversation(pcId, {
          taskId: 'c',
          mode: M,
          tabId: tab,
          conversationId: id,
          origin: 'slay-spawned-fresh'
        })
        await hub.ledger.markSessionFirstTurn(pcId, id)
        expected.set(tab, id)
        owner.set(id, tab)
        done.session++
      } else if (action === 1) {
        await resetConversation(h.slayDb, { taskId: 'c', mode: M, scope: { tabId: tab } })
        expected.set(tab, null)
        done.reset++
      } else {
        // Pick one of the other tab's sessions that it is not running.
        const pickable = [...owner].filter(([id, t]) => t === other && expected.get(other) !== id)
        if (!pickable.length) continue
        const [id] = pickable[rand(pickable.length)]
        expect(
          await switchConversation(
            h.slayDb,
            { taskId: 'c', mode: M, conversationId: id, tabId: tab },
            { release: async () => {}, liveInOtherTab: async () => null }
          )
        ).toBe('switched')
        expected.set(tab, id)
        owner.set(id, tab)
        done.pick++
      }
      if (step % 12 === 11) await restartAndCheck(`day 11 (step ${step})`)
      for (const t of tabsOfC)
        expect(
          await hub.ledger.store.getCurrentConversationId(pcId, 'c', M, t),
          `day 11 step ${step} ${t}`
        ).toBe(expected.get(t))
    }
    // The seeded sequence exercises every action.
    expect(Math.min(done.session, done.reset, done.pick), JSON.stringify(done)).toBeGreaterThan(0)

    // Day 12 (P3): damaged items on the computer — a torn file-save journal and a
    // deleted-task cleanup row whose id can never name a folder. Each fails (or
    // completes) alone: every chat still opens, agents start, uploads still work.
    const runtimeDir = join(dir, 'pc', 'computer-runtime')
    const store = join(runtimeDir, readdirSync(runtimeDir).find((d) => /^[a-f0-9]{64}$/.test(d))!)
    const tornJournal = join(
      store,
      'artifacts',
      '.transactions',
      '00000000-0000-4000-8000-00000000d12a'
    )
    mkdirSync(tornJournal, { recursive: true })
    writeFileSync(join(tornJournal, 'manifest.json'), '{"taskId":"a","artifa')
    const raw = new Database(join(store, 'chat.sqlite'))
    raw.exec(
      "INSERT INTO task_lifecycle VALUES('..','deleted',1); INSERT INTO task_cleanup_pending VALUES('..')"
    )
    raw.close()
    await restartAndCheck('day 12 (damaged items)')
    await upload('a', chats.get('a')![0], 'after-damage.txt')
    await restartAndCheck('day 12 (damaged items, again)')
    const check = new Database(join(store, 'chat.sqlite'), { readonly: true })
    expect(check.prepare('SELECT task_id FROM task_cleanup_pending').all()).toEqual([])
    check.close()
    const needsAttention = await createItemFaultService({
      db: h.slayDb,
      isConnected: () => true,
      requestComputer: request
    }).list({ computerId: pcId, dataRoot: join(dir, 'hub') })
    expect(needsAttention).toMatchObject([
      { origin: 'computer', source: 'quarantine', pass: 'artifact-file-journal', discardable: true }
    ])
    expect(await checkHubChatConsistency(h.slayDb)).toEqual([])

    // Day 12: the computer is restored from an older backup (plan §5). Work
    // after the backup — a chat upload, a pause — is missing there. The hub
    // re-reads instead of dropping updates at reused positions, keeps the newer
    // file listed as unavailable, and delivers the pause again.
    const pcDir = join(dir, 'pc'),
      pcBackup = join(dir, 'pc-backup')
    await pc.close()
    cpSync(pcDir, pcBackup, { recursive: true })
    pc = openComputer()
    await hub.chat.recoverComputer(pcId)
    const cTab = chats.get('c')![0]
    const lost = (await upload('c', cTab, 'after-backup.txt'))!
    sql("UPDATE tasks SET archived_at=datetime('now') WHERE id='d'")
    await restartAndCheck('day 12 (before restore)')
    await pc.close()
    rmSync(pcDir, { recursive: true, force: true })
    cpSync(pcBackup, pcDir, { recursive: true })
    pc = openComputer()
    await restartAndCheck('day 12 (computer restored)')
    const listed = async (task: string) =>
      new Map((await hub.files.listArtifactsByTask(h.slayDb, task)).map((a) => [a.id, a] as const))
    expect((await listed('c')).get(lost.id), 'day 12: newer file kept').toMatchObject({
      title: 'Chat attachment · unavailable on computer',
      storage: { available: false }
    })
    await expect(pc.request({ kind: 'task.lifecycles' })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: 'd', state: 'paused' })])
    )
    // New work after the restore lands at the computer's (reused) positions.
    const afterRestore = (await upload('c', cTab, 'after-restore.txt'))!
    await restartAndCheck('day 12 (after restore)')
    expect((await listed('c')).get(afterRestore.id), 'day 12: new file applied').toMatchObject({
      title: 'after-restore.txt',
      storage: { available: true }
    })

    // Day 13: the hub is restored from an older backup. Work after it — an
    // unarchive, an upload — is on the computer only. The computer's newer task
    // revision never fences the task; its newer file is re-read.
    const hubBackup = join(dir, 'hub-backup.sqlite')
    h.db.exec(`VACUUM INTO '${hubBackup}'`)
    sql("UPDATE tasks SET archived_at=NULL WHERE id='d'")
    await hub.chat.recoverComputer(pcId)
    await hub.chat.lifecycle.sync(pcId)
    const newer = (await upload('c', cTab, 'after-hub-backup.txt'))!
    await restartAndCheck('day 13 (before restore)')
    restoreDatabase(h.db, hubBackup)
    expect(
      h.db.prepare("SELECT archived_at IS NOT NULL AS archived FROM tasks WHERE id='d'").get()
    ).toEqual({ archived: 1 })
    await restartAndCheck('day 13 (hub restored)')
    expect((await listed('c')).get(newer.id), 'day 13: computer file re-read').toMatchObject({
      title: 'after-hub-backup.txt',
      storage: { available: true }
    })
    // The hub is the authority: its (restored) pause wins, past the computer's revision.
    await expect(pc.request({ kind: 'task.lifecycles' })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: 'd', state: 'paused' })])
    )
    sql("UPDATE tasks SET archived_at=NULL WHERE id='d'")
    await restartAndCheck('day 13 (unarchived again)')

    // Day 14 (P0, plan §9): computer-only data the hub still holds is staged while the
    // computer is offline. The reconnect hands it over once; the hub keeps no copy, a
    // second restart sends nothing, and work starting on a task flushes its rows first.
    await pc.close()
    const stage = (key: string, task: string, text: string) =>
      sql(
        'INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at) VALUES(?,?,?,?,0)',
        'soak',
        key,
        task,
        JSON.stringify({ text, at: 1 })
      )
    stage('a-1', 'a', 'one')
    stage('c-1', 'c', 'two')
    pc = openComputer()
    await restartAndCheck('day 14 (handoff after offline)')
    expect(h.db.prepare('SELECT COUNT(*) n FROM computer_data_handoff').get()).toEqual({ n: 0 })
    const soakRows = () => {
      const db = new Database(join(store, 'chat.sqlite'), { readonly: true })
      try {
        return db.prepare('SELECT key,task_id,text FROM soak_data ORDER BY key').all()
      } finally {
        db.close()
      }
    }
    expect(soakRows()).toEqual([
      { key: 'a-1', task_id: 'a', text: 'one' },
      { key: 'c-1', task_id: 'c', text: 'two' }
    ])
    await restartAndCheck('day 14 (again)')
    stage('d-1', 'd', 'three')
    await hub.handoff.flushTask('d', pcId)
    expect(soakRows()).toHaveLength(3)
    await restartAndCheck('day 14 (after a flush)')

    // Day 15 (decision 2): chat settings live only on the chat's computer. A new
    // chat takes its task's starting values; changes there survive restarts with no
    // hub copy; two clients setting at once leave one value, on the computer.
    const hubChatKeys = (task: string) => {
      const row = h.db.prepare('SELECT provider_config FROM tasks WHERE id=?').get(task) as {
        provider_config: string | null
      }
      const entry = JSON.parse(row.provider_config ?? '{}')['claude-chat'] ?? {}
      return Object.keys(entry).filter((key) => key.startsWith('chat'))
    }
    sql(
      "INSERT INTO tasks(id,project_id,title,has_worktree,provider_config) VALUES('s','p','s',1,?)",
      JSON.stringify({ 'claude-chat': { chatModel: 'haiku' } })
    )
    // As task creation does: its paths go to its computer (§9, Phase 7a).
    await notifyTaskPaths('s', { op: 'set', worktreePath: dir })
    const eTab = addChat('s')
    await open('s', eTab)
    expect(await hub.chat.relay.ops.getModel('s', 'claude-chat'), 'day 15: seeded').toBe('haiku')
    expect(hubChatKeys('s'), 'day 15: starting value released').toEqual([])
    const target = (task: string, tabId: string) => ({
      tabId,
      taskId: task,
      mode: 'claude-chat',
      cwd: dir
    })
    const aTab = chats.get('a')![0]
    await hub.chat.relay.ops.setModel({ ...target('a', aTab), chatModel: 'opus' })
    await hub.chat.relay.ops.setEffort({ ...target('a', aTab), chatEffort: 'high' })
    await restartAndCheck('day 15 (settings changed, restart 1)')
    await restartAndCheck('day 15 (settings changed, restart 2)')
    expect(await hub.chat.relay.ops.getModel('a', 'claude-chat')).toBe('opus')
    expect(await hub.chat.relay.ops.getEffort('a', 'claude-chat')).toBe('high')
    expect(hubChatKeys('a'), 'day 15: no hub copy').toEqual([])
    await Promise.all([
      hub.chat.relay.ops.setModel({ ...target('a', aTab), chatModel: 'sonnet' }),
      hub.chat.relay.ops.setModel({ ...target('a', aTab), chatModel: 'haiku' })
    ])
    const settled = await hub.chat.relay.ops.getModel('a', 'claude-chat')
    expect(['sonnet', 'haiku']).toContain(settled)
    await restartAndCheck('day 15 (concurrent edit)')
    expect(await hub.chat.relay.ops.getModel('a', 'claude-chat')).toBe(settled)
    expect(hubChatKeys('a')).toEqual([])

    // Day 16 (§9): sessions live on the computer; the hub keeps the user's intent.
    // A reset made while the computer is offline reaches it on reconnect, and the
    // incident (a main-agent switch resets only the main tab) holds across restarts.
    const current = (tab: string) =>
      hub.ledger.store.getCurrentConversationId(pcId, 'c', 'claude-code', tab)
    for (const [tab, id] of [
      ['c', 'main-16'],
      ['c-deploy', 'bf71421e']
    ] as const) {
      await hub.ledger.store.recordConversation(pcId, {
        taskId: 'c',
        mode: 'claude-code',
        tabId: tab,
        conversationId: id,
        origin: 'slay-spawned-resume'
      })
    }
    await new Promise((r) => setTimeout(r, 3))
    online = false
    // The main-agent switch's reset, made offline: recorded, not yet delivered.
    expect(
      await resetConversation(h.slayDb, { taskId: 'c', scope: { tabId: 'c' }, exceptChat: true })
    ).toEqual(['* (except chat)'])
    online = true
    // Recorded on the hub, not yet held by the computer.
    expect(
      h.db
        .prepare(
          `SELECT COUNT(*) n FROM session_resets r WHERE r.task_id='c'
            AND NOT EXISTS(SELECT 1 FROM session_intent_acks a WHERE a.intent_id=r.id)`
        )
        .get(),
      'day 16: not delivered while offline'
    ).toEqual({ n: 1 })
    await restartAndCheck('day 16 (offline reset delivered)')
    expect(await current('c'), 'day 16: main tab reset').toBeNull()
    expect(await current('c-deploy'), 'day 16: deploy tab keeps bf71421e').toBe('bf71421e')
    await restartAndCheck('day 16 (again)')
    expect(await current('c-deploy')).toBe('bf71421e')

    // Day 17 (v206): ledger rows the hub still held (staged by the migration) reach the
    // computer while it was offline-at-upgrade; the task then resumes the same session.
    online = false
    sql(
      'INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at) VALUES(?,?,?,?,0)',
      'agent-session',
      'legacy-d',
      'd',
      JSON.stringify({
        id: 'legacy-d',
        mode: 'claude-code',
        cwd: null,
        taskId: 'd',
        tabId: 'd',
        conversationId: 'resume-me',
        origin: 'slay-spawned-resume',
        status: 'dead',
        pendingMeta: null,
        createdAt: 5,
        boundAt: 5,
        endedAt: null
      })
    )
    sql(
      'INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at) VALUES(?,?,?,?,0)',
      'session-turn',
      'd:resume-me',
      'd',
      JSON.stringify({ conversationId: 'resume-me', firstTurnAt: 6 })
    )
    online = true
    await restartAndCheck('day 17 (ledger handed off)')
    expect(
      await hub.ledger.store.getCurrentConversationId(pcId, 'd', 'claude-code'),
      'day 17: resumes the handed-off session'
    ).toBe('resume-me')
    expect(
      h.db.prepare("SELECT COUNT(*) n FROM computer_data_handoff WHERE task_id='d'").get()
    ).toEqual({ n: 0 })
    await restartAndCheck('day 17 (again)')
    expect(await hub.ledger.store.getCurrentConversationId(pcId, 'd', 'claude-code')).toBe(
      'resume-me'
    )

    // Day 18 (v207): prompt history and turn snapshots live only on the computer.
    // Rows the hub still held (staged by the migration) reach it after an offline
    // upgrade; a prompt captured later joins them; both survive restarts, and the
    // hub keeps no copy.
    online = false
    const stageHistory = (kind: string, key: string, value: unknown) =>
      sql(
        'INSERT INTO computer_data_handoff(kind,item_key,task_id,payload,created_at) VALUES(?,?,?,?,0)',
        kind,
        key,
        'd',
        JSON.stringify(value)
      )
    stageHistory('agent-prompt', 'legacy-prompt', {
      id: 'legacy-prompt',
      agentId: 'claude-code',
      cliSessionId: 'resume-me',
      text: 'from the hub',
      createdAt: 7
    })
    stageHistory('agent-turn', 'legacy-turn', {
      id: 'legacy-turn',
      worktreePath: '/w-d',
      taskId: 'd',
      tabId: 'd',
      snapshotSha: 'snap',
      headShaAtSnap: 'head',
      promptPreview: 'old preview',
      createdAt: 8
    })
    online = true
    await restartAndCheck('day 18 (history handed off)')
    const turnRows = () => {
      const db = new Database(join(store, 'chat.sqlite'), { readonly: true })
      try {
        return db
          .prepare("SELECT id,prompt_preview FROM agent_turns WHERE task_id='d' ORDER BY id")
          .all()
      } finally {
        db.close()
      }
    }
    expect(turnRows(), 'day 18: the turn reached the computer').toEqual([
      { id: 'legacy-turn', prompt_preview: 'old preview' }
    ])
    await hub.chat.captureHook({
      agentId: 'claude-code',
      mode: 'claude-code',
      hookEvent: 'UserPromptSubmit',
      taskId: 'd',
      sessionId: 'resume-me',
      raw: { prompt: 'typed later' }
    })
    await restartAndCheck('day 18 (again)')
    expect((await hub.chat.prompts('d', 'claude-code')).map((p) => p.text)).toEqual([
      'from the hub',
      'typed later'
    ])
    expect(turnRows()).toEqual([{ id: 'legacy-turn', prompt_preview: 'old preview' }])
    expect(
      h.db.prepare("SELECT COUNT(*) n FROM computer_data_handoff WHERE task_id='d'").get()
    ).toEqual({ n: 0 })

    // Day 19 (v208): the hub keeps no queue routes and no provider bindings. Queued
    // messages are edited through their tab across a provider switch of the task's
    // other chat and restarts; a call naming another tab reaches nothing.
    const queueTab = chats.get('c')![0]
    const q = hub.chat.relay.queueOps
    const first = await q.push(queueTab, 'first', 'first')
    const second = await q.push(queueTab, 'second', 'second')
    expect(await q.move(second.id, 0, queueTab)).toBe(true)
    expect(await q.hold(first.id, queueTab)).toBe(true)
    await q.release(first.id, queueTab)
    const sibling = addChat('c')
    await open('c', sibling)
    for (const mode of ['codex-chat', 'claude-chat']) {
      sql('UPDATE terminal_tabs SET mode=? WHERE id=?', mode, sibling)
      await open('c', sibling)
      chats.set('c', [...new Set(chats.get('c'))])
      await restartAndCheck(`day 19 (${mode})`)
    }
    const queued = async () =>
      (await hub.chat.relay.queueOps.list(queueTab)).map((m: { send: string }) => m.send)
    expect(await queued()).toEqual(['second', 'first'])
    // Another tab of the task cannot reach this tab's message.
    expect(await hub.chat.relay.queueOps.remove(first.id, sibling)).toBe(false)
    expect(
      await hub.chat.relay.queueOps.update(
        second.id,
        { send: 'edited', original: 'edited', content: [{ type: 'text', text: 'edited' }] },
        queueTab
      )
    ).toBe(true)
    await restartAndCheck('day 19 (queue edited)')
    expect(await queued()).toEqual(['edited', 'first'])
    expect(await hub.chat.relay.queueOps.remove(first.id, queueTab)).toBe(true)
    expect(await hub.chat.relay.queueOps.clear(queueTab)).toBe(1)
    await restartAndCheck('day 19 (queue cleared)')
    expect(
      h.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('chat_provider_bindings','chat_queue_routes')"
        )
        .all()
    ).toEqual([])

    // Day 20 (§9 Phase 8): the legacy chat tables went at the first boot (nothing to
    // migrate). The hub is restored from a backup older than that drop: the tables
    // are back, holding a hub-era chat. The next boot keeps them; the chat opens
    // (migrated to the computer); the boot after drops them again.
    expect(legacyChatTablesSync(h.db).size).toBe(0)
    for (const statement of legacySchema) h.db.exec(statement)
    sql('DELETE FROM settings WHERE key=?', LEGACY_CHAT_TABLES_DROPPED_SETTING)
    const hubEra = addChat('a')
    sql('INSERT INTO chat_tab_state(tab_id,draft_text,updated_at) VALUES(?,?,1)', hubEra, hubEra)
    sql(
      'INSERT INTO chat_events(tab_id,seq,event) VALUES(?,0,?)',
      hubEra,
      JSON.stringify({ kind: 'user-message', id: 'hub-era', text: 'from the hub era' })
    )
    chats.set('a', [...(chats.get('a') ?? []), hubEra])
    await restartAndCheck('day 20 (older backup restored)')
    expect(legacyChatTablesSync(h.db).size).toBe(LEGACY_CHAT_TABLES.length)
    expect(h.db.prepare('SELECT COUNT(*) n FROM chat_tab_state').get()).toEqual({ n: 0 })
    await restartAndCheck('day 20 (migrated: dropped again)')
    expect(legacyChatTablesSync(h.db).size).toBe(0)
    expect(
      h.db
        .prepare('SELECT 1 AS one FROM settings WHERE key=?')
        .get(LEGACY_CHAT_TABLES_DROPPED_SETTING)
    ).toEqual({ one: 1 })

    // Day 21 (§9 Phase 7a/7e): a task's worktree path / base dir live only on the
    // computer holding its folders; the hub keeps whether each is set. A path the user
    // sets is judged there and needs it connected (refused while away, nothing
    // recorded); a subtask's computer copies its parent's paths; an archive's clear
    // made while the computer is away is staged and lands after the restart, on the
    // computer that holds the folders. A task whose folder is there stays there.
    const pathsOf = async (ids: string[]) =>
      (await request(pcId, { kind: 'taskPaths', value: { op: 'get', taskIds: ids } })) as Array<{
        taskId: string
        worktreePath: string | null
        baseDir: string | null
      }>
    const flagsOf = (id: string) =>
      h.db
        .prepare('SELECT has_worktree, has_base_dir, worktree_computer_id FROM tasks WHERE id=?')
        .get(id)
    const moved = join(dir, 'moved-worktree')
    mkdirSync(moved, { recursive: true })
    online = false
    await expect(
      updateTask(h.slayDb, { id: 'a', worktreePath: moved, baseDir: dir })
    ).rejects.toThrow()
    expect(flagsOf('a')).toMatchObject({ has_worktree: 1, has_base_dir: 0 })
    online = true
    await updateTask(h.slayDb, { id: 'a', worktreePath: moved, baseDir: dir })
    expect(flagsOf('a')).toEqual({ has_worktree: 1, has_base_dir: 1, worktree_computer_id: pcId })
    await restartAndCheck('day 21 (paths set)')
    expect(await pathsOf(['a'])).toEqual([
      expect.objectContaining({ worktreePath: moved, baseDir: dir })
    ])
    // A path inside another task's folder is refused there (the hub never sees it).
    await expect(updateTask(h.slayDb, { id: 'b', baseDir: moved })).rejects.toThrow()
    sql(
      "INSERT INTO tasks(id,project_id,title,parent_id,computer_id,worktree_computer_id,has_worktree,has_base_dir) SELECT 'a-sub','p','Sub','a',computer_id,worktree_computer_id,1,1 FROM tasks WHERE id='a'"
    )
    await notifyTaskPaths('a-sub', { op: 'inherit', parentTaskId: 'a' })
    online = false
    sql("UPDATE tasks SET archived_at=datetime('now'), has_worktree=0, has_base_dir=0 WHERE id='c'")
    await notifyTaskPaths('c', { op: 'clear' })
    expect(
      h.db.prepare("SELECT item_key FROM computer_data_handoff WHERE kind='task-path'").all()
    ).toEqual([{ item_key: 'c' }])
    online = true
    await restartAndCheck('day 21 (inherit, archive while away)')
    expect(
      h.db.prepare("SELECT 1 FROM computer_data_handoff WHERE kind='task-path'").all()
    ).toEqual([])
    expect(await pathsOf(['a-sub', 'c'])).toEqual([
      expect.objectContaining({ taskId: 'a-sub', worktreePath: moved, baseDir: dir }),
      expect.objectContaining({ taskId: 'c', worktreePath: null, baseDir: null })
    ])
    // Its folder is on this computer: pinning it elsewhere is refused.
    await expect(assertTaskMovable(h.slayDb, 'a', 'elsewhere')).rejects.toThrow()
    expect(
      h.db
        .prepare(
          "SELECT name FROM pragma_table_info('tasks') WHERE name IN ('worktree_path','base_dir')"
        )
        .all()
    ).toEqual([])

    // The checker sees the drift a direct database edit causes (2026-11-08: an
    // agent moved files to another task in the hub's SQLite only).
    const drifted = (await upload('a', chats.get('a')![0], 'drift.png'))!
    sql("UPDATE task_artifacts SET task_id='c' WHERE id=?", drifted.id)
    sql('DELETE FROM chat_artifact_locations WHERE artifact_id=?', drifted.id)
    expect(await checkComputerChatConsistency(h.slayDb, request, pcId)).toEqual([
      expect.objectContaining({
        rule: 'computer-file-drift',
        ids: [drifted.id, expect.any(String)]
      })
    ])
  } finally {
    setTaskPathsDelegate(null)
    warnings.mockRestore()
    errors.mockRestore()
    await pc.close()
    fakeClaude.dispose()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Replace every row of `db` with the rows of the database file `file` (same
 * schema): a hub restored from a backup, in place. Triggers are dropped while
 * copying (no side effects of the restore itself) and recreated as they were.
 */
function restoreDatabase(db: import('better-sqlite3').Database, file: string) {
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'")
    .all() as Array<{ name: string; sql: string }>
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>
  const q = (name: string) => `"${name.replaceAll('"', '""')}"`
  db.pragma('foreign_keys = OFF')
  db.prepare('ATTACH ? AS snap').run(file)
  try {
    db.transaction(() => {
      for (const t of triggers) db.exec(`DROP TRIGGER ${q(t.name)}`)
      for (const { name } of tables) {
        db.exec(`DELETE FROM main.${q(name)}`)
        db.exec(`INSERT INTO main.${q(name)} SELECT * FROM snap.${q(name)}`)
      }
      for (const t of triggers) db.exec(t.sql)
    })()
  } finally {
    db.exec('DETACH snap')
    db.pragma('foreign_keys = ON')
  }
}
