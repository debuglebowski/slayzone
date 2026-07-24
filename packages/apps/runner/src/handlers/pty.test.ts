import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { RunnerConfig } from '../config'
import { createPtyHandlers } from './pty'
import type { RunnerDialer } from './types'

interface Notify {
  method: string
  params: Record<string, unknown>
}

function makeCtx() {
  const notifies: Notify[] = []
  const dialer: RunnerDialer = {
    notify: (method, params) => {
      notifies.push({ method, params: (params ?? {}) as Record<string, unknown> })
      return true
    }
  }
  const config: RunnerConfig = {
    hubUrl: 'ws://localhost:0/runners',
    name: 'test',
    allowedRoots: [tmpdir()],
    capabilities: ['pty']
  }
  return { notifies, ctx: { dialer, config, log: () => {} } }
}

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function dataParams(notifies: Notify[]): Array<{ seq: number; data: string }> {
  return notifies
    .filter((n) => n.method === 'pty.data')
    .map((n) => ({ seq: n.params.seq as number, data: n.params.data as string }))
}

describe('createPtyHandlers', () => {
  it('streams monotonic pty.data, replays a gap via getBufferSince, then emits pty.exit', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    const sessionId = 'sess-1'

    // `cat` echoes stdin back through the pty and stays alive until killed —
    // deterministic control over when frames arrive.
    const spawned = (await pty.handlers['pty.spawn']({
      sessionId,
      command: 'cat',
      cwd: process.cwd()
    })) as { pid: number }
    expect(spawned.pid).toBeGreaterThan(0)

    await pty.handlers['pty.write']({ sessionId, data: 'alpha\n' })
    await waitFor(() =>
      dataParams(notifies)
        .map((f) => f.data)
        .join('')
        .includes('alpha')
    )
    await pty.handlers['pty.write']({ sessionId, data: 'bravo\n' })
    await waitFor(() =>
      dataParams(notifies)
        .map((f) => f.data)
        .join('')
        .includes('bravo')
    )

    const frames = dataParams(notifies)
    expect(frames.length).toBeGreaterThan(1)
    // Seq is monotonic and dense from 0 (one append per emitted frame).
    frames.forEach((f, i) => expect(f.seq).toBe(i))

    // Gap replay: the hub says "I have up to seq N, give me the rest".
    const sinceSeq = frames[0].seq
    const replay = (await pty.handlers['pty.getBufferSince']({ sessionId, seq: sinceSeq })) as {
      frames: Array<{ seq: number; data: string }>
    }
    const expected = frames.filter((f) => f.seq > sinceSeq)
    expect(replay.frames.map((f) => f.seq)).toEqual(expected.map((f) => f.seq))
    expect(replay.frames.map((f) => f.data).join('')).toBe(expected.map((f) => f.data).join(''))

    // Kill → exit notification, and the session is cleaned up afterwards.
    await pty.handlers['pty.kill']({ sessionId })
    await waitFor(() => notifies.some((n) => n.method === 'pty.exit'))
    const exit = notifies.find((n) => n.method === 'pty.exit')!.params
    expect(exit.sessionId).toBe(sessionId)

    const afterExit = (await pty.handlers['pty.getBufferSince']({ sessionId, seq: 0 })) as {
      frames: unknown[]
    }
    expect(afterExit.frames).toEqual([])

    pty.disposeAll()
  })

  it('emits pty.exit with exitCode 0 for a short-lived command', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    await pty.handlers['pty.spawn']({
      sessionId: 's2',
      command: 'sh',
      args: ['-c', 'printf hi'],
      cwd: process.cwd()
    })
    await waitFor(() => notifies.some((n) => n.method === 'pty.exit'))
    const exit = notifies.find((n) => n.method === 'pty.exit')!.params
    expect(exit.exitCode).toBe(0)
    pty.disposeAll()
  })

  it('re-spawning the same sessionId does not let the old pty tear down the replacement', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    const sessionId = 'dup'

    await pty.handlers['pty.spawn']({ sessionId, command: 'cat', cwd: process.cwd() })
    // Replace it with a fresh pty under the SAME id (kills the first).
    await pty.handlers['pty.spawn']({ sessionId, command: 'cat', cwd: process.cwd() })
    // Give the killed original time to fire its (now-superseded) exit.
    await new Promise((r) => setTimeout(r, 250))
    expect(notifies.some((n) => n.method === 'pty.exit')).toBe(false)

    // The replacement is alive and streaming.
    await pty.handlers['pty.write']({ sessionId, data: 'ping\n' })
    await waitFor(() =>
      dataParams(notifies)
        .map((f) => f.data)
        .join('')
        .includes('ping')
    )

    // Exactly one exit fires — for the active session only.
    await pty.handlers['pty.kill']({ sessionId })
    await waitFor(() => notifies.filter((n) => n.method === 'pty.exit').length === 1)
    await new Promise((r) => setTimeout(r, 100))
    expect(notifies.filter((n) => n.method === 'pty.exit').length).toBe(1)

    pty.disposeAll()
  })

  it('getBufferSince on an unknown session returns no frames', async () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    const res = (await pty.handlers['pty.getBufferSince']({ sessionId: 'nope', seq: 0 })) as {
      frames: unknown[]
    }
    expect(res.frames).toEqual([])
  })

  it('overlays the runner loopback SLAYZONE_AGENT_HOOK_URL and strips any hub token', async () => {
    // The agent must ALWAYS post its hook to the runner's OWN loopback relay —
    // never to a hub URL the hub baked in. The runner overlays the URL at spawn
    // and strips any stray SLAYZONE_HUB_TOKEN so no per-agent bearer leaks into
    // the subprocess env.
    const { ctx } = makeCtx()
    const hookUrl = 'http://127.0.0.1:54999/api/agent-hook'
    const pty = createPtyHandlers({ ...ctx, agentHookUrl: hookUrl })
    const sessionId = 'env-check'

    // Spawn `env` and capture its output to inspect the child's environment.
    let out = ''
    const dialer: RunnerDialer = {
      notify: (method, params) => {
        if (method === 'pty.data') out += (params as { data: string }).data
        return true
      }
    }
    const pty2 = createPtyHandlers({ ...ctx, dialer, agentHookUrl: hookUrl })
    await pty2.handlers['pty.spawn']({
      sessionId,
      command: 'sh',
      args: ['-c', 'echo HOOK=$SLAYZONE_AGENT_HOOK_URL; echo TOKEN=[$SLAYZONE_HUB_TOKEN]'],
      cwd: process.cwd(),
      env: {
        // The hub baked in a (now-wrong) hub hook URL + a bearer; the runner
        // must override the URL and drop the token.
        SLAYZONE_AGENT_HOOK_URL: 'https://hub.example:8443/api/agent-hook',
        SLAYZONE_HUB_TOKEN: 'should-be-stripped',
        SLAYZONE_AGENT_ID: 'claude-code'
      }
    })
    await waitFor(() => out.includes('HOOK=') && out.includes('TOKEN='))
    expect(out).toContain(`HOOK=${hookUrl}`)
    expect(out).toContain('TOKEN=[]')
    pty2.disposeAll()
    pty.disposeAll()
  })

  it('WITHOUT agentHookUrl, passes env through byte-identically (no overlay, no strip)', async () => {
    // Pre-init / tests: the relay port is not yet bound → no agentHookUrl. The
    // env must be passed through UNCHANGED so this stays a no-op seam (behavior
    // identical to before the split existed).
    const { ctx } = makeCtx()
    let out = ''
    const dialer: RunnerDialer = {
      notify: (method, params) => {
        if (method === 'pty.data') out += (params as { data: string }).data
        return true
      }
    }
    const pty = createPtyHandlers({ ...ctx, dialer }) // NOTE: no agentHookUrl
    const sessionId = 'passthrough'
    await pty.handlers['pty.spawn']({
      sessionId,
      command: 'sh',
      args: ['-c', 'echo HOOK=$SLAYZONE_AGENT_HOOK_URL; echo TOKEN=[$SLAYZONE_HUB_TOKEN]'],
      cwd: process.cwd(),
      env: {
        SLAYZONE_AGENT_HOOK_URL: 'https://hub.example:8443/api/agent-hook',
        SLAYZONE_HUB_TOKEN: 'kept-as-is',
        SLAYZONE_AGENT_ID: 'claude-code'
      }
    })
    await waitFor(() => out.includes('HOOK=') && out.includes('TOKEN='))
    // Untouched: whatever the hub sent survives verbatim.
    expect(out).toContain('HOOK=https://hub.example:8443/api/agent-hook')
    expect(out).toContain('TOKEN=[kept-as-is]')
    pty.disposeAll()
  })
})
