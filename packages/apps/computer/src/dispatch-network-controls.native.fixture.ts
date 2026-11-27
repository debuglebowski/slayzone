/** Isolated real WS/enrollment/actor/scope dispatch + packaged canonical writer. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { startLoopbackHub } from '@slayzone/computer-transport/testing'
import { HubDialer, createMemoryCredentialStore } from '@slayzone/computer-transport/client'
import {
  HubToComputerMethods as M,
  ComputerToHubMethods as C
} from '@slayzone/computer-transport/shared'
import { runWithSecurityContext, setSecurityLogSink } from '@slayzone/platform/security-log'
import { runInPathScope } from '@slayzone/platform/path-scope'
import { createHubRequestHandler } from './main'
import { runMigrations } from '../../../shared/db-migrations/src/migrations'
import { createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from '../../../domains/chat-runtime/src/server/hub-ownership'
import { createHubChatRelay } from '../../../domains/chat-runtime/src/server/hub-relay'
import { chatRouter } from '../../../domains/terminal/src/server/chat-router'
import { setChatDeps } from '../../../domains/terminal/src/server/chat-router-deps'

const [root, extension, mode = 'claude-chat'] = process.argv.slice(2)
let phase = 'setup'
const r1Case = process.env.SLAYZONE_TEST_CONTROL_LIFETIME_CASE
let holdPrepare = false,
  heldPrepare: { token: string; spawnId: string } | undefined,
  releasePrepare: (() => void) | undefined
setSecurityLogSink(() => {
  // Keep fixture stdout a single metrics record; no audit contents are exported.
})
const publicControls = process.env.SLAYZONE_TEST_PUBLIC_CONTROLS === '1'
// Isolated hub metadata bootstrap; computer production constructors stay refused.
const hubDb = publicControls ? new Database(':memory:') : null
if (hubDb) {
  const log = console.log
  try {
    console.log = () => {
      // Migration chatter is outside the single metrics record.
    }
    runMigrations(hubDb)
  } finally {
    console.log = log
  }
}
const counter = new Database(':memory:')
counter.loadExtension(extension)
assert.throws(() => new Database(':memory:'), /Native SQLite constructor refused/)
const control = (sql: string) => (counter.prepare(sql).get() as { n: number }).n
// Fails after 8 s without the condition. With `progress`, the 8 s restart whenever it
// grows: a throughput wait (event burst) fails on a stall, not on host load.
const until = async (test: () => boolean, progress?: () => number) => {
  let deadline = Date.now() + 8000,
    seen = progress?.()
  while (!test()) {
    const now = progress?.()
    if (now !== seen) {
      seen = now
      deadline = Date.now() + 8000
    }
    assert(Date.now() < deadline, 'native network deadline')
    await new Promise((r) => setTimeout(r, 5))
  }
}
const bin = join(root, 'bin')
mkdirSync(bin)
// Protocol test provider, no external CLI/account. Real child + real stdout pipe.
const script = join(bin, 'provider.cjs')
writeFileSync(
  script,
  `
const fs=require('node:fs'), readline=require('node:readline');
const out=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const codex=process.env.FIXTURE_MODE==='codex-chat';
let started=false;
// Codex mints a fresh id per turn; an ended turn id never carries new output.
let turn='turn',turns=0;
// Like Codex, an interrupted turn completes only after its streaming stops.
let bursting=null;
const timer=setInterval(()=>{
 if(started||!fs.existsSync(process.env.FIXTURE_GATE))return;
 started=true;clearInterval(timer);fs.unlinkSync(process.env.FIXTURE_GATE);
 bursting=burst().finally(()=>{bursting=null;});
},5);
async function burst(){
 fs.writeFileSync(process.env.FIXTURE_GATE+'.started','');
 for(let i=0;i<1200;i++){
  const text=i+':'+'é'.repeat(1024);
  const record=codex?{method:'item/agentMessage/delta',params:{threadId:'thread',turnId:turn,itemId:'item'+i,delta:text}}
   :{type:'assistant',message:{id:'m'+i,role:'assistant',content:[{type:'text',text}]}};
  const ready=out(record);
  const complete=codex?out({method:'item/completed',params:{threadId:'thread',turnId:turn,item:{type:'agentMessage',id:'item'+i,text}}}):true;
  if(!ready||!complete)
   await new Promise(r=>process.stdout.once('drain',r));
 }
}
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='control_request'){
  if(m.request.subtype==='interrupt')fs.appendFileSync(process.env.FIXTURE_ACK,'ack\\n');
  out({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{ack:m.request.subtype}}});
  if(m.request.subtype==='interrupt')out({type:'result',subtype:'error_during_execution',is_error:true,num_turns:1,terminal_reason:'aborted_streaming'});
 }else if(m.type==='user'){
  fs.appendFileSync(process.env.FIXTURE_SENT,'sent\\n');
  out({type:'command_lifecycle',command_uuid:m.uuid,state:'started'});
 }else if(m.id!==undefined){
  let result={};
  if(m.method==='initialize')result={userAgent:'codex-cli/0.166.0'};
  if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:'thread',turns:[]},model:'fixture',cwd:process.cwd()};
  if(m.method==='thread/read')result={thread:{id:'thread',turns:[]}};
  if(m.method==='thread/backgroundTerminals/list'||m.method==='model/list')result={data:[],nextCursor:null};
  if(m.method==='turn/start')fs.appendFileSync(process.env.FIXTURE_SENT,'sent\\n');
  if(m.method==='turn/start'){turn='turn-'+(++turns);result={turn:{id:turn,status:'inProgress',items:[]}};}
  if(m.method==='turn/interrupt')fs.appendFileSync(process.env.FIXTURE_ACK,'ack\\n');
  out({id:m.id,result});
  if(m.method==='turn/start')out({method:'turn/started',params:{threadId:'thread',turn:{id:turn,status:'inProgress'}}});
  if(m.method==='turn/interrupt'){
   const done=()=>out({method:'turn/completed',params:{threadId:'thread',turn:{id:m.params?.turnId??turn,status:'interrupted',items:[]}}});
   if(bursting)bursting.then(done);else done();
  }
  if(m.method==='thread/start')out({method:'turn/started',params:{threadId:'thread',turn:{id:'turn',status:'inProgress'}}});
 }
});
`
)
for (const name of ['claude', 'codex'])
  writeFileSync(
    join(bin, name),
    `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}'\n`,
    { mode: 0o700 }
  )
const identity = { id: 'c', taskId: 't', tabId: 'tab', mode, epoch: 1 }
const scope = { kind: 'task' as const, taskId: 't', projectId: null }
async function connected(hubScope: string) {
  const hub = await startLoopbackHub({ heartbeatTimeoutMs: 1000 })
  let heartbeats = 0
  hub.wss.on('connection', (ws) =>
    ws.on('message', (data) => {
      if (JSON.parse(data.toString()).method === C.heartbeat) heartbeats++
    })
  )
  let completedBursts = 0,
    savedEvents = 0
  hub.gateway.events.on('event', (ev) => {
    if (ev.name !== 'chat-runtime') return
    const p = ev.payload as {
      type?: string
      live?: number
      event?: { kind?: string; text?: string }
    }
    if (p?.type === 'event' && p.live === undefined) savedEvents++
    if (p?.type === 'event' && p.live === undefined && p.event?.text === '1199:' + 'é'.repeat(1024))
      completedBursts++
  })
  let computerId: string | null = null
  const dialer = new HubDialer({
    url: hub.url,
    identity: {
      name: hubScope,
      platform: process.platform + '-' + process.arch,
      version: 'fixture',
      capabilities: ['fs', 'proc'],
      chatProcessControls: true,
      chatControlInvocations: true,
      chatControlLeases: true
    },
    credentialStore: createMemoryCredentialStore(),
    joinToken: 'jt-valid',
    heartbeatIntervalMs: 25,
    heartbeatTimeoutMs: 500,
    onHubRequest: (method, params, actor) => dispatch.handle(method, params, actor)
  })
  const dispatch = createHubRequestHandler({
    stateDir: root,
    hubScope,
    getComputerId: () => computerId,
    shutdown: () => {
      // Fixture disposes only its own dispatch; no shutdown RPC is issued.
    },
    dialer,
    config: {
      hubUrl: hub.url,
      name: hubScope,
      allowedRoots: [root],
      capabilities: ['fs', 'proc'],
      binOverrideDir: bin
    }
  })
  if (r1Case && hubScope === 'native-a') {
    const handle = dispatch.handle
    dispatch.handle = async (method, params, actor) => {
      if (
        r1Case === 'lost' &&
        method === M.chatRequest &&
        (params as { kind?: string })?.kind === 'control.cancel'
      )
        throw new Error('fixture dropped cleanup frame before delivery')
      const result = await handle(method, params, actor)
      if (
        holdPrepare &&
        method === M.chatRequest &&
        (params as { kind?: string })?.kind === 'control.prepare' &&
        (result as { available?: boolean })?.available
      ) {
        holdPrepare = false
        heldPrepare = result as typeof heldPrepare
        return new Promise((resolve) => {
          releasePrepare = () => resolve(result)
        })
      }
      return result
    }
  }
  dialer.events.on('disconnected', ({ reason }) => dispatch.hubDisconnected(String(reason)))
  const ready = dialer.events.once('connected')
  dialer.start()
  computerId = (await ready).computerId
  assert.equal(hub.gateway.listComputers()[0].chatProcessControls, true)
  // A number is the bound this proof asserts (default: answers within 2 s even while a
  // native fence blocks; a call that waits on the fence never answers). 'hub' is the
  // gateway's own production deadline, for cold work the proof does not bound: a
  // hub's first chat call boots its runtime (worker, bundle, SQLite), measured >2 s
  // under host load.
  const request = (
    method: string,
    params: unknown,
    scoped = true,
    timeout: number | 'hub' = 2000
  ) => {
    const timeoutMs = timeout === 'hub' ? undefined : timeout
    return runWithSecurityContext(
      { actor: 'native-fixture', ip: '127.0.0.1', route: 'native controls' },
      () =>
        scoped
          ? runInPathScope(scope, () => hub.gateway.request(computerId!, method, params, timeoutMs))
          : hub.gateway.request(computerId!, method, params, timeoutMs)
    )
  }
  return {
    hub,
    computerId,
    dialer,
    dispatch,
    request,
    beats: () => heartbeats,
    completedBursts: () => completedBursts,
    savedEvents: () => savedEvents,
    async close() {
      await dialer.stop()
      await dispatch.dispose()
      await hub.close()
    }
  }
}
async function run() {
  const startSyncs = control('SELECT sync_count() n')
  const a = await connected('native-a'),
    b = await connected('native-b')
  const pending: Promise<unknown>[] = []
  const publicGates: Array<() => void> = []
  let publicControlMs: number | undefined,
    publicHeartbeats: number[] | undefined,
    publicLosslessEvents: number | undefined
  try {
    const infos: Array<{ spawnId: string; pid: number }> = []
    // Setup is cold (runtime boot, provider spawn) and outside any fence: 'hub' deadline.
    for (const [index, h] of [a, b].entries()) {
      await h.request(
        M.chatRequest,
        {
          kind: 'taskPaths',
          value: { op: 'set', taskId: 't', projectId: null, baseDir: root, at: 1 }
        },
        false,
        'hub'
      )
      await h.request(
        M.chatRequest,
        {
          kind: 'bootstrap',
          value: {
            identity,
            projectId: null,
            cwd: root,
            revision: 1,
            providerConfig: {},
            defaultFlags: null,
            env: {
              FIXTURE_MODE: mode,
              FIXTURE_SENT: join(root, index === 0 ? 'sent-a' : 'sent-b'),
              FIXTURE_ACK: join(root, index === 0 ? 'ack-a' : 'ack-b'),
              FIXTURE_GATE: join(root, index === 0 ? 'burst-a' : 'burst-b'),
              ELECTRON_RUN_AS_NODE: '1'
            }
          }
        },
        false,
        'hub'
      )
      infos.push(
        (await h.request(
          M.chatRequest,
          {
            kind: 'invoke',
            value: {
              route: { id: 'c', epoch: 1 },
              target: 'ops',
              method: 'start',
              operationId: 'start',
              args: [{ taskId: 't', tabId: 'tab', mode, cwd: root }]
            }
          },
          true,
          'hub'
        )) as { spawnId: string; pid: number }
      )
      await h.request(M.chatRequest, { kind: 'relay.watch', all: true, tabIds: [] }, true, 'hub')
      await h.request(
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
        true,
        'hub'
      )
    }
    control('SELECT block_sync(1) n')
    let acknowledged = false,
      filesystemDone = false
    pending.push(
      a
        .request(
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
          true,
          8000
        )
        .then(() => {
          acknowledged = true
        })
    )
    void pending.at(-1)!.catch(() => undefined)
    await until(() => !!control('SELECT sync_blocked() n'))
    pending.push(
      a.request(M.fsPathExists, { path: root }, true, 8000).then(() => {
        filesystemDone = true
      })
    )
    void pending.at(-1)!.catch(() => undefined)
    // Observe real frames from both automatic heartbeat loops during the fence.
    const beats = [a.beats(), b.beats()]
    const firstBurst = a.completedBursts()
    writeFileSync(join(root, 'burst-a'), 'go')
    const at = Date.now()
    await a.request(M.ping, {})
    await b.request(M.ping, {})
    assert.deepEqual(await a.request(M.procKill, { sessionId: 'same-id', spawnId: 'one' }), {
      ok: true,
      clean: true
    })
    const controlRequest = {
      kind: 'control',
      identity,
      spawnId: infos[0].spawnId,
      action: 'interrupt'
    }
    await assert.rejects(
      a.request(M.chatRequest, { ...controlRequest, identity: { ...identity, epoch: 2 } }),
      /ownership|identity/i
    )
    await assert.rejects(
      a.request(M.chatRequest, { ...controlRequest, identity: { ...identity, id: 'foreign' } }),
      /ownership|identity/i
    )
    await assert.rejects(
      a.request(M.chatRequest, { ...controlRequest, identity: { ...identity, taskId: 'foreign' } }),
      /scope/i
    )
    await assert.rejects(a.dispatch.handle(M.chatRequest, controlRequest, {}), /actor|protocol/i)
    await assert.rejects(
      a.request(M.chatRequest, { ...controlRequest, spawnId: 'stale' }),
      /generation/i
    )
    const ack = await a.request(M.chatRequest, controlRequest)
    assert.deepEqual(ack, { acknowledged: true, spawnId: infos[0].spawnId, scope: 'provider' })
    // Real hub B write + provider control, not only a main-thread timer/ping.
    await b.request(M.chatRequest, {
      kind: 'invoke',
      value: {
        route: { id: 'c', epoch: 1 },
        target: 'ops',
        method: 'saveTabDraft',
        operationId: 'unrelated-draft',
        args: ['tab', { text: 'other hub', attachments: [] }]
      }
    })
    await b.request(M.chatRequest, { ...controlRequest, spawnId: infos[1].spawnId })
    assert.equal(readFileSync(join(root, 'ack-a'), 'utf8'), 'ack\n')
    assert.equal(readFileSync(join(root, 'ack-b'), 'utf8'), 'ack\n')
    assert(JSON.stringify(await b.request(M.procList, {}, false)).includes('same-id'))
    await until(() => a.beats() >= beats[0] + 4 && b.beats() >= beats[1] + 4)
    assert.equal(a.dialer.state, 'connected')
    assert.equal(b.dialer.state, 'connected')
    assert.equal(acknowledged, false)
    assert.equal(filesystemDone, false)
    const controlMs = Date.now() - at
    const blockedHeartbeats = [a.beats() - beats[0], b.beats() - beats[1]]
    control('SELECT block_sync(0) n')
    await Promise.all(pending)
    await until(() => a.completedBursts() > firstBurst, a.savedEvents)
    // Read through the normal network history API, after its accepted spool
    // prefix drains. Every provider byte becomes the original ordered event.
    const page = (await a.request(
      M.chatRequest,
      {
        kind: 'invoke',
        value: {
          route: { id: 'c', epoch: 1 },
          target: 'ops',
          method: 'getEventPage',
          args: ['tab', -1, { maxBytes: 4 * 1024 * 1024, maxEvents: 2000 }]
        }
      },
      true,
      8000
    )) as {
      events: Array<{ event: { kind: string; text?: string; deltaType?: string } }>
    }
    const texts = page.events.flatMap(({ event: e }) =>
      e.kind === 'assistant-text' || (e.kind === 'stream-block-delta' && e.deltaType === 'text')
        ? [e.text]
        : []
    )
    const digest = (value: unknown) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex')
    assert.equal(texts.length, 1200)
    assert.equal(
      digest(texts),
      digest(Array.from({ length: 1200 }, (_, i) => i + ':' + 'é'.repeat(1024)))
    )
    if (hubDb) {
      const db = createSlayzoneDbAdapter(hubDb)
      hubDb.exec(
        "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','T')"
      )
      hubDb
        .prepare("INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','t',?,0)")
        .run(mode)
      const ownership = createChatOwnershipStore(db)
      await ownership.register({ ...identity, computerId: a.computerId })
      const wires: Array<{
        kind: string
        value?: { method?: string; operationId?: string; controlToken?: string }
        token?: string
        spawnId?: string
      }> = []
      const request = async (_pc: string, raw: unknown) => {
        const req = raw as (typeof wires)[number]
        wires.push(req)
        // Unscoped, like every production caller (CLI agent switch, desktop Stop): the
        // relay itself stamps the owner task's scope on its control frames.
        const result = await a.request(M.chatRequest, raw, false, r1Case ? 30000 : 8000)
        if (req.kind === 'control.prepare') wires.push({ kind: 'ACK', ...(result as object) })
        return result
      }
      let bootstrapGate: Promise<void> | undefined, onParked: (() => void) | undefined
      // Holds a public control at its durable step. `parked(call)` resolves once the
      // relay waits here: its prepare ACK and initial lease renewal have both returned,
      // so no control frame is in flight on the socket. It rejects with `call`'s own
      // failure when the call ends without parking, instead of waiting forever.
      const holdBootstrap = () => {
        let release!: () => void
        bootstrapGate = new Promise<void>((r) => {
          release = r
        })
        const parked = new Promise<void>((r) => {
          onParked = r
        })
        publicGates.push(release)
        return {
          parked: (call: Promise<unknown>) =>
            Promise.race([
              parked,
              call.then(() => {
                throw new Error('held public control settled before parking')
              })
            ]),
          resume() {
            bootstrapGate = undefined
            release()
          }
        }
      }
      const relay = createHubChatRelay({
        db,
        ownership,
        request,
        stopRequest: request,
        chatControlInvocations: () => true,
        chatControlLeases: () => true,
        chatRuntimeReady: () => true,
        authorizeControl: async () => {
          // The proof's one caller is the authorized owner.
        },
        resolveComputer: async () => a.computerId,
        defaultComputer: async () => a.computerId,
        bootstrap: async (owner) => {
          if (bootstrapGate) {
            onParked?.()
            await bootstrapGate
          }
          return {
            identity: {
              id: owner.id,
              tabId: owner.tabId,
              taskId: owner.taskId,
              mode: owner.mode,
              epoch: owner.epoch
            },
            projectId: null,
            cwd: root,
            revision: 1,
            providerConfig: {},
            defaultFlags: null,
            env: {
              FIXTURE_MODE: mode,
              FIXTURE_SENT: join(root, 'sent-a'),
              FIXTURE_ACK: join(root, 'ack-a'),
              FIXTURE_GATE: join(root, owner.id === 'c' ? 'burst-a' : 'disabled'),
              ELECTRON_RUN_AS_NODE: '1'
            }
          }
        },
        migrate: async () => {
          throw new Error('unexpected migration')
        },
        onSessionsChanged: () => {
          // No renderer exists in this isolated public caller.
        }
      })
      setChatDeps(relay)
      const caller = chatRouter.createCaller({
        db,
        dataRoot: root,
        principal: { userId: 'native-public', role: 'admin', scopes: ['full'] }
      })
      const opts = { tabId: 'tab', taskId: 't', mode, cwd: root }
      // Prompts the provider really received (it records each one before answering).
      const sentCount = () =>
        existsSync(join(root, 'sent-a'))
          ? readFileSync(join(root, 'sent-a'), 'utf8').split('sent').length - 1
          : 0
      if (r1Case) {
        phase = 'r1-' + r1Case
        const n = sentCount()
        await caller.send({
          tabId: 'tab',
          message: { id: 'r1-user', content: [{ type: 'text', text: 'r1 original' }] }
        })
        await until(() => sentCount() > n)
        const ackCount = () => readFileSync(join(root, 'ack-a'), 'utf8').split('ack').length - 1
        const beforeAck = ackCount(),
          beforeBeats = [a.beats(), b.beats()],
          started = Date.now()
        if (r1Case === 'concurrent') {
          control('SELECT block_sync(1) n')
          const fence = a.request(
            M.chatRequest,
            {
              kind: 'invoke',
              value: {
                route: { id: 'c', epoch: 1 },
                target: 'ops',
                method: 'saveTabDraft',
                operationId: 'r1-full',
                args: ['tab', { text: 'r1 block', attachments: [] }]
              }
            },
            true,
            8000
          )
          pending.push(fence)
          void fence.catch(() => undefined)
          await until(() => !!control('SELECT sync_blocked() n'))
          const first = caller.interrupt(opts)
          pending.push(first)
          void first.catch(() => undefined)
          await until(() => ackCount() === beforeAck + 1)
          const errors: string[] = [],
            overlap = [
              caller.abortAndPop(opts),
              caller.kill({ tabId: 'tab' }),
              caller.remove({ tabId: 'tab' })
            ]
          let settled = 0
          for (const work of overlap) {
            pending.push(work)
            void work.then(
              () => {
                settled++
              },
              (e) => {
                errors.push(String(e))
                settled++
              }
            )
          }
          const dead = () => {
            try {
              process.kill(infos[0].pid, 0)
              return false
            } catch {
              return true
            }
          }
          await until(() => errors.length > 0 || dead())
          assert.deepEqual(errors, [], 'distinct public stops must not be refused')
          assert(dead(), 'physical escalation must precede FULL release')
          assert.equal(settled, 0)
          await a.request(M.ping, {})
          await b.request(M.ping, {})
          control('SELECT block_sync(0) n')
          await fence
          await first
          await Promise.all(overlap)
          assert.equal(ackCount(), beforeAck + 1, 'same generation must receive only one interrupt')
          assert.equal(overlap.length, 3)
          const invokes = wires.filter(
            (w) =>
              w.kind === 'invoke' &&
              ['interrupt', 'abortAndPop', 'kill', 'remove'].includes(w.value?.method ?? '')
          )
          assert.equal(new Set(invokes.map((w) => w.value?.operationId)).size, 4)
        } else {
          holdPrepare = true
          const first = caller.interrupt(opts)
          void first.catch(() => undefined)
          await until(() => !!heldPrepare)
          assert.equal(ackCount(), beforeAck + 1, 'fixture held a real provider ACK reply')
          if (r1Case === 'exit') {
            // Real physical exit must revoke an abandoned preparation even
            // while that generation's accepted output/SQLite drain is blocked.
            control('SELECT block_sync(1) n')
            const fence = a.request(
              M.chatRequest,
              {
                kind: 'invoke',
                value: {
                  route: { id: 'c', epoch: 1 },
                  target: 'ops',
                  method: 'saveTabDraft',
                  operationId: 'exit-full',
                  args: ['tab', { text: 'exit fence', attachments: [] }]
                }
              },
              true,
              8000
            )
            pending.push(fence)
            void fence.catch(() => undefined)
            await until(() => !!control('SELECT sync_blocked() n'))
            await a.request(M.chatRequest, {
              kind: 'control',
              identity,
              spawnId: infos[0].spawnId,
              action: 'kill'
            })
            assert.throws(() => process.kill(infos[0].pid, 0))
            const cut = wires.length
            let failed: unknown,
              done = false
            const killing = caller.kill({ tabId: 'tab' }).then((value) => {
              done = true
              return value
            })
            void killing.catch((error) => {
              failed = error
            })
            await until(
              () =>
                !!failed ||
                wires
                  .slice(cut)
                  .some(
                    (w) => w.kind === 'ACK' && (w as { available?: boolean }).available === false
                  )
            )
            assert.equal(
              failed,
              undefined,
              'physical exit must release isControlled without waiting for drain'
            )
            assert.equal(done, false)
            await a.request(M.ping, {})
            await b.request(M.ping, {})
            control('SELECT block_sync(0) n')
            await fence
            await killing // Original public request still owns its original 30-second RPC deadline.
          }
          await assert.rejects(first, /timed? ?out|timeout/i)
          assert(Date.now() - started >= 30000, 'production RPC deadline must remain 30 seconds')
          if (r1Case === 'late') {
            releasePrepare!()
            await a.request(M.ping, {})
          }
          assert.equal(a.dialer.state, 'connected')
          assert.equal(b.dialer.state, 'connected')
          await a.request(M.ping, {})
          await b.request(M.ping, {})
          assert(
            wires.some((w) => w.kind === 'control.cancel'),
            'caller knows cancellation identity before reply'
          )
          if (r1Case === 'exit') await caller.restart(opts)
          else await caller.interrupt(opts) // Old implementation immediately refuses this valid call.
          const next = sentCount()
          await caller.send({
            tabId: 'tab',
            message: { id: 'r1-next', content: [{ type: 'text', text: 'r1 next' }] }
          })
          await until(() => sentCount() > next)
          const old = wires.find((w) => w.kind === 'control.prepare')!
          const count = ackCount()
          await assert.rejects(
            a.request(M.chatRequest, {
              kind: 'invoke',
              value: { ...old.value, controlToken: heldPrepare!.token }
            }),
            /stale|unconfirmed/i
          )
          assert.equal(ackCount(), count, 'expired token must not interrupt the next turn')
          await caller.interrupt(opts)
        }
        console.log(
          JSON.stringify({
            r1Case,
            provider: mode,
            actualPublicCaller: true,
            actualNetwork: true,
            actualOnlineRuntime: true,
            packagedWorker: true,
            recovered: true,
            losslessEvents: texts.length,
            elapsedMs: Date.now() - started,
            heartbeats: [a.beats() - beforeBeats[0], b.beats() - beforeBeats[1]],
            mainSyncs: control('SELECT sync_count() n') - startSyncs
          })
        )
        return
      }
      // Real public submission and durable queue, before the writer's next FULL.
      const publicSent = sentCount()
      await caller.send({
        tabId: 'tab',
        message: { id: 'public-user', content: [{ type: 'text', text: 'restore this prompt' }] }
      })
      // The stop below must meet a live turn: it proves one provider ACK. Accepted is
      // not delivered, and a prompt the provider has not received yet is popped with
      // no interrupt at all (seen under load, codex-chat).
      await until(() => sentCount() > publicSent)
      await caller.queue.push({
        tabId: 'tab',
        id: 'before-stop',
        send: 'queued before stop',
        original: 'queued before stop'
      })
      assert.equal((await caller.queue.list({ tabId: 'tab' })).length, 1)
      control('SELECT block_sync(1) n')
      const fence = a.request(
        M.chatRequest,
        {
          kind: 'invoke',
          value: {
            route: { id: 'c', epoch: 1 },
            target: 'ops',
            method: 'saveTabDraft',
            operationId: 'public-fence',
            args: ['tab', { text: 'public fence', attachments: [] }]
          }
        },
        true,
        8000
      )
      pending.push(fence)
      void fence.catch(() => undefined)
      await until(() => !!control('SELECT sync_blocked() n'))
      const beforeAck = readFileSync(join(root, 'ack-a'), 'utf8').split('ack').length - 1
      let publicDone = false
      const publicAt = Date.now(),
        publicBeats = [a.beats(), b.beats()]
      phase = 'abort'
      const stopping = caller.abortAndPop(opts).then((result) => {
        publicDone = true
        return result
      })
      pending.push(stopping)
      void stopping.catch(() => undefined)
      await until(() => wires.some((w) => w.kind === 'ACK'))
      assert.equal(readFileSync(join(root, 'ack-a'), 'utf8').split('ack').length - 1, beforeAck + 1)
      assert.equal(publicDone, false)
      publicControlMs = Date.now() - publicAt
      // Later public push stays behind the public stop's existing entry fence.
      const later = caller.queue.push({
        tabId: 'tab',
        id: 'after-stop',
        send: 'survive stop',
        original: 'survive stop'
      })
      pending.push(later)
      void later.catch(() => undefined)
      await a.request(M.ping, {})
      await b.request(M.ping, {})
      await until(() => a.beats() >= publicBeats[0] + 4 && b.beats() >= publicBeats[1] + 4)
      publicHeartbeats = [a.beats() - publicBeats[0], b.beats() - publicBeats[1]]
      assert.equal(publicDone, false)
      control('SELECT block_sync(0) n')
      await fence
      const result = await stopping
      assert.equal(result.popped, true)
      assert.equal(result.text, 'restore this prompt')
      await later
      assert.equal(
        readFileSync(join(root, 'ack-a'), 'utf8').split('ack').length - 1,
        beforeAck + 1,
        'durable continuation must reuse the provider ACK'
      )
      const commit = wires.find((w) => w.kind === 'invoke' && w.value?.method === 'abortAndPop')!
      const prep = wires.find((w) => w.kind === 'control.prepare')!
      assert.equal(commit.value?.operationId, prep.value?.operationId)
      assert.equal(commit.value?.controlToken, wires.find((w) => w.kind === 'ACK')!.token)
      // A successful receipt survives a normal replay, without sending another interrupt.
      phase = 'receipt'
      await a.request(M.chatRequest, commit)
      assert.equal(readFileSync(join(root, 'ack-a'), 'utf8').split('ack').length - 1, beforeAck + 1)
      const queued = await caller.queue.list({ tabId: 'tab' })
      assert(!queued.some((x) => x.id === 'before-stop'))
      const page = await caller.getBufferSince({
        tabId: 'tab',
        afterSeq: -1,
        page: { maxBytes: 4 * 1024 * 1024, maxEvents: 2000 }
      })
      assert(
        JSON.stringify(page).includes('survive stop') || queued.some((x) => x.id === 'after-stop')
      )
      await assert.rejects(
        a.request(M.chatRequest, {
          ...commit,
          value: { ...commit.value, controlToken: 'stale-token', operationId: 'stale-new' }
        }),
        /stale|mismatch/i
      )
      // A public interrupt already ACKed for gen1 must never stop gen2 later.
      phase = 'replacement'
      const replacementHold = holdBootstrap(),
        cut = wires.length
      const replacing = caller.interrupt(opts)
      void replacing.catch(() => undefined)
      await replacementHold.parked(replacing)
      assert(wires.slice(cut).some((w) => w.kind === 'ACK'))
      infos[0] = (await a.request(M.chatRequest, {
        kind: 'invoke',
        value: {
          route: { id: 'c', epoch: 1 },
          target: 'ops',
          method: 'restart',
          operationId: 'replacement',
          args: [opts]
        }
      })) as (typeof infos)[number]
      const replacementAcks = readFileSync(join(root, 'ack-a'), 'utf8')
      replacementHold.resume()
      await assert.rejects(replacing, /stale|generation|mismatch|unconfirmed/i)
      assert.equal(readFileSync(join(root, 'ack-a'), 'utf8'), replacementAcks)
      await assert.rejects(a.request(M.chatRequest, controlRequest), /generation/i)
      // The existing public interrupt, while a real provider burst shares its
      // stdout ACK pipe and the actual canonical FULL writer is blocked.
      phase = 'public-burst'
      const sentBefore = sentCount()
      await caller.send({
        tabId: 'tab',
        message: { id: 'public-burst-user', content: [{ type: 'text', text: 'burst turn' }] }
      })
      await until(() => sentCount() > sentBefore)
      const beforeBurst = await caller.getBufferSince({
        tabId: 'tab',
        afterSeq: -1,
        page: { maxBytes: 4 * 1024 * 1024, maxEvents: 2000 }
      })
      assert(!Array.isArray(beforeBurst) && !beforeBurst.hasMore)
      const afterBurstSeq = beforeBurst.events.at(-1)?.seq ?? -1
      control('SELECT block_sync(1) n')
      const burstFence = a.request(
        M.chatRequest,
        {
          kind: 'invoke',
          value: {
            route: { id: 'c', epoch: 1 },
            target: 'ops',
            method: 'saveTabDraft',
            operationId: 'burst-fence',
            args: ['tab', { text: 'public burst', attachments: [] }]
          }
        },
        true,
        8000
      )
      pending.push(burstFence)
      void burstFence.catch(() => undefined)
      await until(() => !!control('SELECT sync_blocked() n'))
      const burstCut = wires.length,
        burstAcks = readFileSync(join(root, 'ack-a'), 'utf8').split('ack').length - 1
      const publicBurst = a.completedBursts()
      // Interrupt while the provider is really bursting (it polls its gate).
      rmSync(join(root, 'burst-a.started'), { force: true })
      writeFileSync(join(root, 'burst-a'), 'go')
      await until(() => existsSync(join(root, 'burst-a.started')))
      let burstDone = false
      const bursting = caller.interrupt(opts).then((value) => {
        burstDone = true
        return value
      })
      pending.push(bursting)
      void bursting.catch(() => undefined)
      await until(() => wires.slice(burstCut).some((w) => w.kind === 'ACK'))
      assert.equal(burstDone, false)
      assert.equal(readFileSync(join(root, 'ack-a'), 'utf8').split('ack').length - 1, burstAcks + 1)
      await b.request(M.ping, {})
      control('SELECT block_sync(0) n')
      await burstFence
      await bursting
      await until(() => a.completedBursts() > publicBurst, a.savedEvents)
      const burstPage = await caller.getBufferSince({
        tabId: 'tab',
        afterSeq: afterBurstSeq,
        page: { maxBytes: 4 * 1024 * 1024, maxEvents: 2000 }
      })
      assert(!Array.isArray(burstPage) && !burstPage.hasMore)
      const burstTexts = burstPage.events.flatMap(({ event: e }) =>
        e.kind === 'assistant-text' || (e.kind === 'stream-block-delta' && e.deltaType === 'text')
          ? [e.text]
          : []
      )
      assert.equal(burstTexts.length, 1200)
      assert.equal(
        digest(burstTexts),
        digest(Array.from({ length: 1200 }, (_, i) => i + ':' + 'é'.repeat(1024)))
      )
      assert.equal(readFileSync(join(root, 'ack-a'), 'utf8').split('ack').length - 1, burstAcks + 1)
      publicLosslessEvents = burstTexts.length
      // Disconnect cancels only the uncommitted preparation; a new authenticated
      // connection cannot inherit its control token or replay it on a later turn.
      phase = 'reconnect'
      const reconnectHold = holdBootstrap(),
        reconnectCut = wires.length
      const reconnecting = caller.interrupt(opts)
      void reconnecting.catch(() => undefined)
      // Not merely ACKed: a renewal still on the old socket fails as a transport
      // close, before the token can reach the new connection this case proves.
      await reconnectHold.parked(reconnecting)
      assert(wires.slice(reconnectCut).some((w) => w.kind === 'ACK'))
      await a.dialer.stop()
      const ready = a.dialer.events.once('connected')
      a.dialer.start()
      await ready
      const reconnectedAcks = readFileSync(join(root, 'ack-a'), 'utf8')
      reconnectHold.resume()
      await assert.rejects(reconnecting, /stale|mismatch|unconfirmed/i)
      assert.equal(readFileSync(join(root, 'ack-a'), 'utf8'), reconnectedAcks)
      await caller.interrupt(opts)
      // Actual public kill/remove stop the captured process before FULL unblocks;
      // their public result still waits for the ordinary durable invocation.
      const killed = { ...identity, id: 'killed-c', tabId: 'killed-tab' }
      hubDb
        .prepare("INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('killed-tab','t',?,2)")
        .run(mode)
      await ownership.register({ ...killed, computerId: a.computerId })
      const killedOpts = { ...opts, tabId: killed.tabId }
      let killingInfo = await caller.start(killedOpts)
      for (const method of ['kill', 'remove'] as const) {
        phase = 'public-' + method
        control('SELECT block_sync(1) n')
        const fence = a.request(
          M.chatRequest,
          {
            kind: 'invoke',
            value: {
              route: { id: 'c', epoch: 1 },
              target: 'ops',
              method: 'saveTabDraft',
              operationId: 'fence-' + method,
              args: ['tab', { text: method, attachments: [] }]
            }
          },
          true,
          8000
        )
        pending.push(fence)
        void fence.catch(() => undefined)
        await until(() => !!control('SELECT sync_blocked() n'))
        let done = false
        const stopping = caller[method]({ tabId: killed.tabId }).then((value) => {
          done = true
          return value
        })
        pending.push(stopping)
        void stopping.catch(() => undefined)
        const stoppingPid = killingInfo.pid
        assert(stoppingPid !== null)
        await until(() => {
          try {
            process.kill(stoppingPid, 0)
            return false
          } catch {
            return true
          }
        })
        assert.equal(done, false)
        await a.request(M.ping, {})
        control('SELECT block_sync(0) n')
        await fence
        await stopping
        if (method === 'kill') killingInfo = await caller.restart(killedOpts)
      }
      // Conversation deletion revokes a prepared public call before bootstrap.
      phase = 'deletion'
      const deleted = { ...identity, id: 'deleted-c', tabId: 'deleted-tab' }
      hubDb
        .prepare(
          "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('deleted-tab','t',?,1)"
        )
        .run(mode)
      await ownership.register({ ...deleted, computerId: a.computerId })
      const deleteOpts = { ...opts, tabId: deleted.tabId }
      await caller.start(deleteOpts)
      const deleteHold = holdBootstrap(),
        deleteCut = wires.length
      const deleting = caller.interrupt(deleteOpts)
      void deleting.catch(() => undefined)
      await deleteHold.parked(deleting)
      assert(wires.slice(deleteCut).some((w) => w.kind === 'ACK'))
      await a.request(M.chatRequest, { kind: 'conversation.delete', identity: deleted })
      await ownership.deleteConversation(deleted.id)
      const deletedAcks = readFileSync(join(root, 'ack-a'), 'utf8')
      deleteHold.resume()
      await assert.rejects(deleting, /deleted|stale|ownership|mismatch/i)
      assert.equal(readFileSync(join(root, 'ack-a'), 'utf8'), deletedAcks)
    }
    control('SELECT block_sync(1) n')
    // Durable work close must drain. Hub A's writer also commits on its own (timeline
    // checkpoints): when one of those holds the FULL fence first, this draft's
    // admission waits behind it, close begins, and close refuses the draft as new
    // work. Both outcomes are correct; any other draft failure is not.
    let closingDraft: 'accepted' | 'refused-by-close' | undefined
    pending.push(
      a
        .request(
          M.chatRequest,
          {
            kind: 'invoke',
            value: {
              route: { id: 'c', epoch: 1 },
              target: 'ops',
              method: 'saveTabDraft',
              operationId: 'closing-draft',
              args: ['tab', { text: 'closing fence', attachments: [] }]
            }
          },
          true,
          8000
        )
        .then(
          () => {
            closingDraft = 'accepted'
          },
          (error: unknown) => {
            if (!/shutting down|path authority is unavailable/i.test(String(error))) throw error
            closingDraft = 'refused-by-close'
          }
        )
    )
    void pending.at(-1)!.catch(() => undefined)
    await until(() => !!control('SELECT sync_blocked() n'))
    let closeDone = false
    const closing = a.dispatch.dispose().then(() => {
      closeDone = true
    })
    pending.push(closing)
    void closing.catch(() => undefined)
    // Probe only this fixture-owned child's pid. Close must physically stop it
    // before waiting for the native fence and anonymous output-file drain.
    await until(() => {
      try {
        process.kill(infos[0].pid, 0)
        return false
      } catch {
        return true
      }
    })
    assert.equal(closeDone, false)
    await assert.rejects(
      a.request(M.chatRequest, controlRequest),
      /closed|shutting down|unavailable/i
    )
    await b.request(M.chatRequest, { ...controlRequest, spawnId: infos[1].spawnId })
    control('SELECT block_sync(0) n')
    await Promise.all(pending)
    assert(closingDraft, 'the closing draft settled')
    assert.equal(control('SELECT sync_count() n') - startSyncs, 0)
    console.log(
      JSON.stringify({
        actualNetwork: true,
        authenticatedEnrollment: true,
        actualDispatch: true,
        actualOnlineRuntime: true,
        packagedWorker: true,
        multiHub: true,
        actorChecked: true,
        scopedPingAndPhysicalStopWhileNativeSyncBlocked: true,
        freshFilesystemWaited: true,
        ...(publicControls
          ? {
              isolatedHubMetadataOnMain: true,
              computerNativeConstructorsRefused: true,
              computerMainNativeCalls: 0
            }
          : { mainConstructorsRefused: true, mainNativeCalls: 0 }),
        mainSyncs: 0,
        providerCancelAcknowledged: true,
        ...(publicControls
          ? {
              actualPublicCaller: true,
              pendingDurability: true,
              promptRestored: true,
              queueFencePreserved: true,
              singleProviderInterrupt: true,
              durableReceiptReplay: true,
              publicKillRemove: true,
              publicLosslessEvents,
              publicControlMs,
              publicHeartbeats,
              isolatedBootstrapConstructors: 2,
              replacementFenced: true,
              reconnectFenced: true,
              deletionFenced: true
            }
          : {}),
        unrelatedHubWrite: true,
        closeStoppedBeforeNativeFence: true,
        closeAcknowledgementWaited: true,
        closingDraft,
        provider: mode,
        losslessEvents: texts.length,
        heartbeats: blockedHeartbeats,
        controlMs
      })
    )
  } catch (error) {
    // Reported before cleanup: a cleanup that hangs must not hide the failure.
    console.error(phase, error)
    process.exitCode = 1
  } finally {
    for (const resume of publicGates) resume()
    control('SELECT block_sync(0) n')
    await Promise.allSettled(pending)
    await Promise.all([a.close(), b.close()])
    counter.close()
    hubDb?.close()
  }
}
void run().catch((error) => {
  console.error('cleanup', error)
  process.exitCode = 1
})
