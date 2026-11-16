import { spawn } from 'node:child_process'
import files from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { expect, test, vi } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { getBackend } from '../agents/registry'
import { ChatProcess } from './chat-process'
import { childProcessToHandle } from './chat-proc-handle'
import { fakeChild } from './chat-transport-testkit'

// Local protocol implementations, never external CLIs/accounts. The child obeys
// stdout backpressure and writes real control responses on that SAME pipe.
const provider = String.raw`
const readline = require('node:readline');
const mode = process.argv[1];
const out = x => process.stdout.write(JSON.stringify(x) + '\n');
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const m = JSON.parse(line);
  if (m.fixture === 'burst') {
    for (let i = 0; i < m.count; i++) {
      const text = i + ':' + 'é'.repeat(1024);
      const record = mode === 'claude-chat'
        ? {type:'assistant',message:{id:'m'+i,role:'assistant',content:[{type:'text',text}]}}
        : {method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId:'item',delta:text}};
      if (!out(record)) await new Promise(r => process.stdout.once('drain', r));
    }
  } else if (m.type === 'control_request') {
    out({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{ack:m.request.subtype}}});
  } else if (m.id !== undefined) {
    let result = {};
    if (m.method === 'initialize') result = {userAgent:'codex-cli/0.166.0'};
    if (m.method === 'thread/start') result = {thread:{id:'thread'},model:'fixture',cwd:process.cwd()};
    if (m.method === 'thread/read') result = {thread:{id:'thread',turns:[]}};
    if (m.method === 'model/list') result = {data:[]};
    if (m.method === 'thread/backgroundTerminals/list') result = {terminals:[]};
    out({id:m.id,result});
    if (m.method === 'thread/start') out({method:'turn/started',params:{threadId:'thread',turn:{id:'turn',status:'inProgress'}}});
    if (m.method === 'turn/interrupt') out({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'interrupted',items:[]}}});
  }
});
`

for (const mode of ['claude-chat', 'codex-chat']) {
  test(`${mode}: real same-pipe ACK while persistence held, exact lossless ordered drain`, async () => {
    const child = spawn(process.execPath, ['-e', provider, mode], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    const events: AgentEvent[] = []
    const handle = childProcessToHandle(child)
    const proc = new ChatProcess({
      gen: 1,
      spawnId: 'flow-generation',
      handle,
      driver: getBackend(mode)!.createDriver(),
      probeable: true,
      ctx: {
        cwd: process.cwd(),
        sessionId: 'fixture',
        resume: false,
        providerFlags: [],
        chatModel: null,
        chatEffort: null,
        chatMode: null,
        chatCollaboration: null,
        chatFastMode: false
      },
      hooks: {
        onSpawned: () => {},
        onEvent: (_p, e) => events.push(e),
        onExit: () => {},
        onStartError: (_p, e) => {
          throw e
        }
      }
    })
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    try {
      await proc.readyPromise
      const before = events.length
      proc.holdOutputUntil(held)
      await handle.write(JSON.stringify({ fixture: 'burst', count: 1200 }) + '\n')
      // Goes behind several pipe windows of output. A confirmed stdin write is
      // insufficient: the actual driver must consume the child's response.
      if (mode === 'claude-chat') {
        await expect(
          proc.driver.applyControl!({ subtype: 'set_permission_mode', mode: 'default' }, 1500)
        ).resolves.toMatchObject({ response: { ack: 'set_permission_mode' } })
      } else {
        await expect(proc.driver.probeLiveness!(1500)).resolves.toBe(true)
      }
      expect(proc.waitingForStorage).toBe(true)
      expect(events.length).toBe(before)
      expect(proc.outputBufferStats.peakPendingInputBytes).toBeLessThan(256 * 1024)
      release()
      const text = () =>
        events.flatMap((e) =>
          e.kind === 'assistant-text'
            ? [e.text]
            : e.kind === 'stream-block-delta' && e.deltaType === 'text'
              ? [e.text]
              : []
        )
      await expect.poll(() => text().length, { timeout: 8000 }).toBe(1200)
      expect(text()).toEqual(Array.from({ length: 1200 }, (_, i) => i + ':' + 'é'.repeat(1024)))
      await proc.flushOutput()
      expect(proc.outputBufferStats.diskBytes).toBe(0)
      process.stdout.write(
        JSON.stringify({ provider: mode, events: 1200, ...proc.outputBufferStats }) + '\n'
      )
    } finally {
      release()
      child.kill('SIGKILL')
      await proc.exited
    }
  })
}

test('Codex interrupt-and-wait observes real turn completion while its timeline remains paused', async () => {
  const child = spawn(process.execPath, ['-e', provider, 'codex-chat'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  const events: AgentEvent[] = []
  const proc = new ChatProcess({
    gen: 1,
    spawnId: 'wait-generation',
    handle: childProcessToHandle(child),
    driver: getBackend('codex-chat')!.createDriver(),
    probeable: true,
    ctx: {
      cwd: process.cwd(),
      sessionId: 'fixture',
      resume: false,
      providerFlags: [],
      chatModel: null,
      chatEffort: null,
      chatMode: null,
      chatCollaboration: null,
      chatFastMode: false
    },
    hooks: {
      onSpawned: () => {},
      onEvent: (_p, e) => events.push(e),
      onExit: () => {},
      onStartError: (_p, e) => {
        throw e
      }
    }
  })
  let release!: () => void
  const held = new Promise<void>((r) => {
    release = r
  })
  try {
    await proc.readyPromise
    await expect(proc.driver.probeLiveness!(1500)).resolves.toBe(true)
    const before = events.length
    proc.holdOutputUntil(held)
    await expect(
      proc.driver.applyControl!({ subtype: 'interrupt_and_wait' }, 1500)
    ).resolves.toBeUndefined()
    expect(events.length).toBe(before)
    expect(proc.waitingForStorage).toBe(true)
    release()
    await proc.flushOutput()
    expect(events.some((e) => e.kind === 'result' && e.subtype === 'interrupted')).toBe(true)
  } finally {
    release()
    child.kill('SIGKILL')
    await proc.exited
  }
})

test('failed startup retains its anonymous output file through physical close', async () => {
  let release!: () => void,
    opened = false,
    exited = false
  const held = new Promise<void>((r) => {
    release = r
  })
  const originalOpen = files.open
  const spy = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
    const file = await originalOpen(...args)
    const close = file.close.bind(file)
    vi.spyOn(file, 'close').mockImplementation(async () => {
      await held
      await close()
    })
    opened = true
    return file
  })
  syncBuiltinESMExports()
  const f = fakeChild()
  const proc = new ChatProcess({
    gen: 1,
    spawnId: 'failed-start',
    handle: childProcessToHandle(f.child),
    driver: getBackend('claude-chat')!.createDriver(),
    probeable: false,
    ctx: {
      cwd: process.cwd(),
      sessionId: 'fixture',
      resume: false,
      providerFlags: [],
      chatModel: null,
      chatEffort: null,
      chatMode: null,
      chatCollaboration: null,
      chatFastMode: false
    },
    hooks: { onSpawned: () => {}, onEvent: () => {}, onExit: () => {}, onStartError: () => {} }
  })
  try {
    f.stdout.write('{"type":"fixture-before-spawn"}\n')
    await expect.poll(() => opened).toBe(true)
    f.emitter.emit('error', new Error('fixture spawn failed'))
    void proc.exited.then(() => {
      exited = true
    })
    await new Promise<void>((r) => setImmediate(r))
    expect(exited).toBe(false)
    release()
    await proc.exited
  } finally {
    release()
    if (!proc.ended) f.emitter.emit('error', new Error('fixture cleanup'))
    await proc.exited
    spy.mockRestore()
    syncBuiltinESMExports()
    f.stdout.destroy()
    f.stderr.destroy()
  }
})
