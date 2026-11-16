/** Real authorized dispatch, online stores, native xSync, and per-hub process ownership. */
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createHubRequestHandler } from './main'
import { HubToComputerMethods as M } from '@slayzone/computer-transport/shared'

const [root, extension] = process.argv.slice(2)
const counter = new Database(':memory:')
counter.loadExtension(extension)
assert.throws(() => new Database(':memory:'), /Native SQLite constructor refused/)
const control = (sql: string) => (counter.prepare(sql).get() as { n: number }).n
const until = async (test: () => boolean) => {
  const deadline = Date.now() + 8000
  while (!test()) {
    assert(Date.now() < deadline, 'native dispatch deadline')
    await new Promise((r) => setTimeout(r, 5))
  }
}
const actor = { userId: 'native-fixture', route: 'native storage readiness' }
const scoped = { ...actor, pathScope: { kind: 'task', taskId: 't', projectId: null } }
const startSyncs = control('SELECT sync_count() n')
const calls: string[] = []
const originals = new Map<string, (...args: never[]) => unknown>()
for (const name of ['prepare', 'exec', 'pragma', 'backup', 'close'] as const) {
  const original = Database.prototype[name] as (...args: never[]) => unknown
  originals.set(name, original)
  ;(Database.prototype as unknown as Record<string, unknown>)[name] = function (
    this: Database.Database,
    ...args: never[]
  ) {
    if (this !== counter) calls.push(name)
    return Reflect.apply(original, this, args)
  }
}
const make = (hubScope: string) =>
  createHubRequestHandler({
    stateDir: root,
    hubScope,
    getComputerId: () => 'pc',
    shutdown: () => {
      /* Shutdown is not requested in this native proof. */
    },
    dialer: { notify: () => true },
    config: {
      hubUrl: `ws://${hubScope}/computers`,
      name: hubScope,
      allowedRoots: [root],
      capabilities: ['fs', 'proc']
    }
  })
const a = make('native-a'),
  b = make('native-b')
async function run() {
  try {
    for (const h of [a, b]) {
      await h.handle(
        M.chatRequest,
        {
          kind: 'taskPaths',
          value: { op: 'set', taskId: 't', projectId: null, baseDir: root, at: 1 }
        },
        actor
      )
      await h.handle(
        M.chatRequest,
        {
          kind: 'bootstrap',
          value: {
            identity: { id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
            projectId: null,
            cwd: root,
            revision: 1,
            providerConfig: {},
            defaultFlags: null,
            env: {}
          }
        },
        actor
      )
      await h.handle(
        M.procSpawn,
        {
          sessionId: 'same-id',
          spawnId: 'one',
          taskId: 't',
          command: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
          cwd: root,
          env: { ELECTRON_RUN_AS_NODE: '1' }
        },
        scoped
      )
    }
    control('SELECT block_sync(1) n')
    let acknowledged = false,
      filesystemDone = false
    const writing = a
      .handle(
        M.chatRequest,
        {
          kind: 'invoke',
          value: {
            route: { id: 'c', epoch: 1 },
            target: 'ops',
            method: 'saveTabDraft',
            operationId: 'native-draft',
            args: ['tab', { text: 'native delayed commit', attachments: [] }]
          }
        },
        scoped
      )
      .then(() => {
        acknowledged = true
      })
    await until(() => !!control('SELECT sync_blocked() n'))
    const reading = a.handle(M.fsPathExists, { path: root }, scoped).then((value) => {
      filesystemDone = true
      return value
    })
    await assert.rejects(a.handle(M.ping, {}, {}), /actor|protocol/)
    const at = Date.now()
    await a.handle(M.ping, {}, scoped)
    await b.handle(M.ping, {}, scoped)
    assert.deepEqual(await a.handle(M.procKill, { sessionId: 'same-id', spawnId: 'one' }, scoped), {
      ok: true,
      clean: true
    })
    const surviving = await b.handle(M.procList, {}, actor)
    assert(JSON.stringify(surviving).includes('same-id'))
    assert.equal(acknowledged, false)
    assert.equal(filesystemDone, false)
    const controlMs = Date.now() - at
    control('SELECT block_sync(0) n')
    await writing
    await reading
    await b.handle(M.procKill, { sessionId: 'same-id', spawnId: 'one' }, scoped)
    await a.dispose()
    await b.dispose()
    assert.deepEqual(calls, [])
    assert.equal(control('SELECT sync_count() n') - startSyncs, 0)
    console.log(
      JSON.stringify({
        mainConstructorsRefused: true,
        actualDispatch: true,
        actualOnlineRuntime: true,
        packagedWorker: true,
        multiHub: true,
        actorChecked: true,
        scopedPingAndPhysicalStopWhileNativeSyncBlocked: true,
        freshFilesystemWaited: true,
        mainNativeCalls: 0,
        mainSyncs: 0,
        controlMs
      })
    )
  } finally {
    control('SELECT block_sync(0) n')
    await Promise.all([a.dispose(), b.dispose()])
    for (const [name, original] of originals)
      (Database.prototype as unknown as Record<string, unknown>)[name] = original
    counter.close()
  }
}
void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
