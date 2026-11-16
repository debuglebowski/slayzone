/** Isolated real WS/enrollment/actor/scope dispatch + packaged canonical writer. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const [root, extension, mode = 'claude-chat'] = process.argv.slice(2)
setSecurityLogSink(() => {
  // Keep fixture stdout a single metrics record; no audit contents are exported.
})
const counter = new Database(':memory:')
counter.loadExtension(extension)
assert.throws(() => new Database(':memory:'), /Native SQLite constructor refused/)
const control = (sql: string) => (counter.prepare(sql).get() as { n: number }).n
const until = async (test: () => boolean) => {
  const deadline = Date.now() + 8000
  while (!test()) {
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
const timer=setInterval(async()=>{
 if(started||!fs.existsSync(process.env.FIXTURE_GATE))return;
 started=true;clearInterval(timer);
 for(let i=0;i<1200;i++){
  const text=i+':'+'é'.repeat(1024);
  const record=codex?{method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'item'+i,delta:text}}
   :{type:'assistant',message:{id:'m'+i,role:'assistant',content:[{type:'text',text}]}};
  const ready=out(record);
  const complete=codex?out({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',id:'item'+i,text}}}):true;
  if(!ready||!complete)
   await new Promise(r=>process.stdout.once('drain',r));
 }
},5);
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='control_request'){
  if(m.request.subtype==='interrupt')fs.appendFileSync(process.env.FIXTURE_ACK,'ack\\n');
  out({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{ack:m.request.subtype}}});
 }else if(m.id!==undefined){
  let result={};
  if(m.method==='initialize')result={userAgent:'codex-cli/0.166.0'};
  if(m.method==='thread/start')result={thread:{id:'thread'},model:'fixture',cwd:process.cwd()};
  if(m.method==='thread/backgroundTerminals/list'||m.method==='model/list')result={data:[],nextCursor:null};
  if(m.method==='turn/interrupt')fs.appendFileSync(process.env.FIXTURE_ACK,'ack\\n');
  out({id:m.id,result});
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
  let computerId: string | null = null
  const dialer = new HubDialer({
    url: hub.url,
    identity: {
      name: hubScope,
      platform: process.platform + '-' + process.arch,
      version: 'fixture',
      capabilities: ['fs', 'proc'],
      chatProcessControls: true
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
  const ready = dialer.events.once('connected')
  dialer.start()
  computerId = (await ready).computerId
  assert.equal(hub.gateway.listComputers()[0].chatProcessControls, true)
  const request = (method: string, params: unknown, scoped = true, timeoutMs = 2000) =>
    runWithSecurityContext(
      { actor: 'native-fixture', ip: '127.0.0.1', route: 'native controls' },
      () =>
        scoped
          ? runInPathScope(scope, () => hub.gateway.request(computerId!, method, params, timeoutMs))
          : hub.gateway.request(computerId!, method, params, timeoutMs)
    )
  return {
    hub,
    dialer,
    dispatch,
    request,
    beats: () => heartbeats,
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
  try {
    const infos: Array<{ spawnId: string; pid: number }> = []
    for (const [index, h] of [a, b].entries()) {
      await h.request(
        M.chatRequest,
        {
          kind: 'taskPaths',
          value: { op: 'set', taskId: 't', projectId: null, baseDir: root, at: 1 }
        },
        false
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
              FIXTURE_ACK: join(root, index === 0 ? 'ack-a' : 'ack-b'),
              FIXTURE_GATE: join(root, index === 0 ? 'burst-a' : 'burst-b'),
              ELECTRON_RUN_AS_NODE: '1'
            }
          }
        },
        false
      )
      infos.push(
        (await h.request(M.chatRequest, {
          kind: 'invoke',
          value: {
            route: { id: 'c', epoch: 1 },
            target: 'ops',
            method: 'start',
            operationId: 'start',
            args: [{ taskId: 't', tabId: 'tab', mode, cwd: root }]
          }
        })) as { spawnId: string; pid: number }
      )
      await h.request(M.procSpawn, {
        sessionId: 'same-id',
        spawnId: 'one',
        taskId: 't',
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: root,
        env: { ELECTRON_RUN_AS_NODE: '1' }
      })
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
    control('SELECT block_sync(1) n')
    pending.push(
      a.request(
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
        mainConstructorsRefused: true,
        mainNativeCalls: 0,
        mainSyncs: 0,
        providerCancelAcknowledged: true,
        unrelatedHubWrite: true,
        closeStoppedBeforeNativeFence: true,
        closeAcknowledgementWaited: true,
        provider: mode,
        losslessEvents: texts.length,
        heartbeats: blockedHeartbeats,
        controlMs
      })
    )
  } finally {
    control('SELECT block_sync(0) n')
    await Promise.allSettled(pending)
    await Promise.all([a.close(), b.close()])
    counter.close()
  }
}
void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
