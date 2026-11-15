/**
 * S5: the computer's store commits with synchronous=NORMAL (synced off-thread within
 * ~1 s), so an OS crash can leave it behind what the hub and its clients already saw.
 * Its next start (unclean, another boot) rotates the store id: the hub re-reads that
 * computer's conversations as another database and tells their clients to reload, so
 * clients converge on the computer's history — no duplicated or interleaved sequences.
 */
import Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from './test-session-store'
import { createFixtureChatRuntime } from '../../computer/src/project-scope.fixture'
import { createComputerChatServices } from './computer-chat'

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function chatStore(root: string): string {
  const base = join(root, 'computer-runtime')
  const [scope] = readdirSync(base)
  return join(base, scope, 'chat.sqlite')
}

test('a computer store that lost its last events after an OS crash: the hub re-syncs its clients', async () => {
  const h = await createTestHarness(),
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-store-rollback-'))
  const computer = () =>
    createFixtureChatRuntime({
      taskFolder: () => dir,
      stateDir: dir,
      hubScope: 'hub',
      computerId: () => 'pc',
      getProjectPaths: () => null,
      ctx: {
        config: {
          hubUrl: 'ws://hub/computers',
          name: 'test',
          allowedRoots: [dir],
          capabilities: ['proc']
        },
        dialer: { notify: () => true },
        log: () => {}
      }
    })
  let pc = computer()
  vi.stubEnv('PLAYWRIGHT', '1')
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','P','#000')").run()
    h.db
      .prepare('INSERT INTO tasks(id,project_id,title,has_worktree) VALUES(?,?,?,1)')
      .run('task', 'p', 'Task')
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    const services = createComputerChatServices({
      db: h.slayDb,
      legacyData: {
        ...createDbChatDataOps(h.slayDb, taskSessionStore),
        buildMcpEnv: async () => ({})
      },
      attachments: { read: async () => new Uint8Array() },
      request: async (_pc, raw) => wire(await pc.request(wire(raw))),
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      connected: () => true,
      hasLiveTask: async () => false
    })
    // A client: reads the tab's whole saved history from its computer (a pure read:
    // opening the tab would write settings and give the hub another reason to reload).
    const read = async () =>
      (await services.testing.readEvents('tab', -1, 1000)).map((e) => ({
        seq: e.seq,
        text: (e.event as { text: string }).text
      }))
    // ...and reloads it whenever the hub says so.
    let client: Array<{ seq: number; text: string }> = []
    const reloads: Promise<void>[] = []
    let signals = 0
    services.relay.events.on('replay-required', (tabId) => {
      if (tabId !== 'tab') return
      signals++
      reloads.push(
        read().then((events) => {
          client = events
        })
      )
    })
    const text = (t: string) => ({ kind: 'assistant-text', messageId: t, text: t })
    await services.relay.ensureTab('tab')
    services.invalidateRecovery('pc')
    await services.recoverComputer('pc') // the baseline after hub start
    await services.testing.seedEvents(
      'tab',
      0,
      Array.from({ length: 10 }, (_, i) => text(`event ${i}`))
    )
    services.invalidateRecovery('pc')
    await services.recoverComputer('pc')
    await Promise.all(reloads.splice(0))
    expect(client.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    signals = 0

    // OS crash: the computer's last three commits never reached its disk.
    await pc.close()
    const file = chatStore(dir)
    const raw = new Database(file)
    raw.prepare('DELETE FROM events WHERE seq >= 7').run()
    raw
      .prepare("UPDATE maintenance_cursors SET value=? WHERE id='store-session'")
      .run(JSON.stringify({ clean: false, bootedAt: 0 })) // stopped uncleanly, on an earlier boot
    raw.close()
    pc = computer()
    services.invalidateRecovery('pc')
    await services.recoverComputer('pc')
    await Promise.all(reloads.splice(0))
    expect(signals).toBe(1)
    expect(client.map((e) => e.text)).toEqual(Array.from({ length: 7 }, (_, i) => `event ${i}`))

    // History goes on from the computer's sequence: no duplicate, nothing interleaved.
    await services.testing.seedEvents('tab', 7, [text('after the crash')])
    client = await read()
    expect(client.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(client.at(-1)?.text).toBe('after the crash')
  } finally {
    vi.unstubAllEnvs()
    await pc.close()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})
