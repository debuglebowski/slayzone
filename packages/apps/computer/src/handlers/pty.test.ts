import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerConfig } from '../config'
import { createSpawnAdmission } from '../spawn-admission'
import { createPtyHandlers } from './pty'
import type { ComputerDialer } from './types'

interface Notify {
  method: string
  params: Record<string, unknown>
}

/** `online: false` models a computer whose hub connection is down — every
 *  notification is recorded but reported undelivered, as the real dialer does. */
function makeCtx({ online = true }: { online?: boolean } = {}) {
  const notifies: Notify[] = []
  const dialer: ComputerDialer = {
    notify: (method, params) => {
      notifies.push({ method, params: (params ?? {}) as Record<string, unknown> })
      return online
    }
  }
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    // process.cwd() is where these spawns run; a spawn cwd must be inside the jail (T-27).
    allowedRoots: [tmpdir(), process.cwd()],
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

  it('live frame N and buffered frame N are byte-identical (hub mixes the two sources per seq)', async () => {
    // The hub's `ingest` keeps whichever copy of a seq ARRIVES FIRST and drops
    // the other (`if (seq <= entry.lastSeq) return`), so a stream can be assembled
    // from live frame 3 + backfilled frame 4 + live frame 5. That makes the two
    // sources interchangeable BY CONTRACT: any per-seq divergence corrupts the
    // assembled stream — dropping bytes in one ordering and stranding a torn
    // escape prefix in the other. So the computer must never emit a frame whose
    // buffered bytes differ from its live bytes.
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    const sessionId = 'sess-parity'

    // Emit output torn mid-query across two pty reads, then stay alive so the
    // buffer is still queryable.
    await pty.handlers['pty.spawn']({
      sessionId,
      command: 'sh',
      args: [
        '-c',
        'printf "one\\n"; sleep 0.3; printf "two\\033[?6"; sleep 0.3; printf "nthree\\n"; exec tail -f /dev/null'
      ],
      cwd: process.cwd()
    })
    await waitFor(() =>
      dataParams(notifies)
        .map((f) => f.data)
        .join('')
        .includes('three')
    )

    const replay = (await pty.handlers['pty.getBufferSince']({ sessionId, seq: 0 })) as {
      frames: Array<{ seq: number; data: string }>
    }
    const bufferedBySeq = new Map(replay.frames.map((f) => [f.seq, f.data]))
    for (const frame of dataParams(notifies)) {
      if (!bufferedBySeq.has(frame.seq)) continue // evicted, not divergent
      expect(bufferedBySeq.get(frame.seq)).toBe(frame.data)
    }

    await pty.handlers['pty.kill']({ sessionId })
    await waitFor(() => notifies.some((n) => n.method === 'pty.exit'))
    pty.disposeAll()
  })

  it('warm session buffers silently, then adopt rekeys it with pid + seq continuity', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)

    const warm = (await pty.handlers['pty.warmSpawn']({
      warmId: 'warm-1',
      command: 'cat',
      cwd: process.cwd()
    })) as { pid: number }
    expect(warm.pid).toBeGreaterThan(0)

    // Output produced BEFORE adoption must not be streamed: the hub has no
    // session to route it to, and adopt hands the whole buffer over instead.
    await pty.handlers['pty.write']({ sessionId: 'warm-1', data: 'preboot\n' })
    await waitFor(
      () => (pty.handlers['pty.warmList']({}) as { warms: unknown[] }).warms.length === 1
    )
    await new Promise((r) => setTimeout(r, 150))
    expect(dataParams(notifies)).toEqual([])

    const listed = (await pty.handlers['pty.warmList']({})) as {
      warms: Array<{ warmId: string; pid: number; cwd: string }>
    }
    expect(listed.warms[0]).toMatchObject({ warmId: 'warm-1', pid: warm.pid })

    const adopted = (await pty.handlers['pty.warmAdopt']({
      warmId: 'warm-1',
      sessionId: 'sess-warm'
    })) as { pid: number; data: string; seq: number }

    // SAME process — adoption rekeys, it never respawns.
    expect(adopted.pid).toBe(warm.pid)
    expect(adopted.data).toContain('preboot')
    expect(adopted.seq).toBeGreaterThanOrEqual(0)

    // No longer warm, and now streaming under the REAL session id.
    expect((pty.handlers['pty.warmList']({}) as { warms: unknown[] }).warms).toEqual([])
    await pty.handlers['pty.write']({ sessionId: 'sess-warm', data: 'after\n' })
    await waitFor(() =>
      dataParams(notifies)
        .map((f) => f.data)
        .join('')
        .includes('after')
    )
    const live = notifies.filter((n) => n.method === 'pty.data')
    expect(live.every((n) => n.params.sessionId === 'sess-warm')).toBe(true)

    // Seq CONTINUES past the handover rather than restarting — the whole reason
    // adoption rekeys the buffer instead of replaying a seed into a fresh one.
    expect(dataParams(notifies)[0].seq).toBeGreaterThan(adopted.seq)

    // ...and backfill spanning the boundary still resolves against that buffer.
    const replay = (await pty.handlers['pty.getBufferSince']({
      sessionId: 'sess-warm',
      seq: -1
    })) as { frames: Array<{ seq: number; data: string }> }
    expect(replay.frames.map((f) => f.data).join('')).toContain('preboot')

    pty.disposeAll()
  })

  it('warm exit before adoption stays silent; adopting an unknown warm throws', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)

    await pty.handlers['pty.warmSpawn']({
      warmId: 'warm-dies',
      command: 'sh',
      args: ['-c', 'exit 0'],
      cwd: process.cwd()
    })
    // The hub holds no session for a warm id, so a pre-adopt death must not
    // surface as pty.exit — it would tear down a session that never existed.
    await waitFor(
      () => (pty.handlers['pty.warmList']({}) as { warms: unknown[] }).warms.length === 0
    )
    expect(notifies.some((n) => n.method === 'pty.exit')).toBe(false)

    expect(() => pty.handlers['pty.warmAdopt']({ warmId: 'warm-dies', sessionId: 's' })).toThrow(
      /no warm session/
    )

    pty.disposeAll()
  })

  it('warmKill reaps an unclaimed warm (orphan reconcile) and is idempotent', async () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)

    await pty.handlers['pty.warmSpawn']({
      warmId: 'warm-orphan',
      command: 'cat',
      cwd: process.cwd()
    })
    expect((pty.handlers['pty.warmList']({}) as { warms: unknown[] }).warms).toHaveLength(1)

    await pty.handlers['pty.warmKill']({ warmId: 'warm-orphan' })
    expect((pty.handlers['pty.warmList']({}) as { warms: unknown[] }).warms).toEqual([])
    // Idempotent: the hub reconciles against a list that may already be stale.
    await pty.handlers['pty.warmKill']({ warmId: 'warm-orphan' })

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

  it('getBufferSince accepts seq -1 and replays from seq 0 (opening-chunk recovery)', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    const sessionId = 'sess-from-start'

    await pty.handlers['pty.spawn']({ sessionId, command: 'cat', cwd: process.cwd() })
    await pty.handlers['pty.write']({ sessionId, data: 'first\n' })
    await waitFor(() =>
      dataParams(notifies)
        .map((f) => f.data)
        .join('')
        .includes('first')
    )

    // -1 is what the hub sends when the chunk it is missing is seq 0 itself: its
    // gap detector starts at lastSeq = -1. Rejecting it (the old `nonnegative()`
    // bound) made the caller's best-effort catch swallow the failure and the
    // session lose its opening output permanently.
    const replay = (await pty.handlers['pty.getBufferSince']({ sessionId, seq: -1 })) as {
      frames: Array<{ seq: number; data: string }>
    }
    expect(replay.frames[0]?.seq).toBe(0)
    expect(replay.frames.map((f) => f.data).join('')).toContain('first')

    await pty.handlers['pty.kill']({ sessionId })
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

  it('overlays the computer loopback SLAYZONE_AGENT_HOOK_URL and strips any hub token', async () => {
    // The agent must ALWAYS post its hook to the computer's OWN loopback relay —
    // never to a hub URL the hub baked in. The computer overlays the URL at spawn
    // and strips any stray SLAYZONE_HUB_TOKEN so no per-agent bearer leaks into
    // the subprocess env.
    const { ctx } = makeCtx()
    const hookUrl = 'http://127.0.0.1:54999/api/agent-hook'
    const pty = createPtyHandlers({ ...ctx, agentHookUrl: hookUrl })
    const sessionId = 'env-check'

    // Spawn `env` and capture its output to inspect the child's environment.
    let out = ''
    const dialer: ComputerDialer = {
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
        // The hub baked in a (now-wrong) hub hook URL + a bearer; the computer
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

  it('overlays SLAYZONE_HUB_ADDRESS with the hub this connection dials', async () => {
    // `slay` inside a task terminal must talk to the hub that spawned it, never to
    // whatever `slay hub use/login` stored on this machine. The computer is the one
    // side that knows how THIS box reaches that hub (it dials it), so it sets the
    // address — overriding anything the hub sent, which is the hub's own view.
    const { ctx } = makeCtx()
    let out = ''
    const dialer: ComputerDialer = {
      notify: (method, params) => {
        if (method === 'pty.data') out += (params as { data: string }).data
        return true
      }
    }
    const pty = createPtyHandlers({ ...ctx, dialer, hubAddress: '127.0.0.1:51101' })
    await pty.handlers['pty.spawn']({
      sessionId: 'hub-address',
      command: 'sh',
      args: ['-c', 'echo ADDR=[$SLAYZONE_HUB_ADDRESS]'],
      cwd: process.cwd(),
      env: { SLAYZONE_HUB_ADDRESS: 'hub-view.example:9', SLAYZONE_TASK_ID: 'task-1' }
    })
    await waitFor(() => out.includes('ADDR='))
    expect(out).toContain('ADDR=[127.0.0.1:51101]')
    pty.disposeAll()
  })

  it('sanitizes the inherited process.env base: strips infra/secret/identity + non-prefixed infra, keeps PATH', async () => {
    // The computer inherits its parent (supervisor) process.env, which carries
    // SlayZone infra/secret/identity vars. NONE of those may leak into a spawned
    // agent's env — a computer-hosted `slay` reinterpreting an inherited
    // SLAYZONE_HUB_ADDRESS/HUB_TOKEN/TASK_ID is the exact leak this closes. The
    // user env (PATH/HOME/toolchains) MUST survive. This is the BASE channel
    // (process.env), distinct from the hub-passed override channel tested above.
    const saved: Record<string, string | undefined> = {}
    const inject: Record<string, string> = {
      SLAYZONE_HUB_ADDRESS: 'hub.example:8443', // infra
      SLAYZONE_HUB_TOKEN: 'inherited-secret', // secret
      SLAYZONE_HUB_REQUIRE_LOGIN: '1', // infra
      SLAYZONE_TASK_ID: 'inherited-task', // identity (overlay would re-add correct)
      SLAYZONE_FUTURE_UNLISTED: 'fail-closed', // unmanifested → fail closed
      ELECTRON_RUN_AS_NODE: '1' // non-prefixed infra
    }
    for (const [k, v] of Object.entries(inject)) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
    try {
      const { ctx } = makeCtx()
      let out = ''
      const dialer: ComputerDialer = {
        notify: (method, params) => {
          if (method === 'pty.data') out += (params as { data: string }).data
          return true
        }
      }
      const pty = createPtyHandlers({ ...ctx, dialer })
      await pty.handlers['pty.spawn']({
        sessionId: 'base-sanitize',
        command: 'sh',
        args: [
          '-c',
          'echo ADDR=[$SLAYZONE_HUB_ADDRESS]; echo TOK=[$SLAYZONE_HUB_TOKEN]; ' +
            'echo LOGIN=[$SLAYZONE_HUB_REQUIRE_LOGIN]; echo TASK=[$SLAYZONE_TASK_ID]; ' +
            'echo FUT=[$SLAYZONE_FUTURE_UNLISTED]; echo ERAN=[$ELECTRON_RUN_AS_NODE]; ' +
            'echo PATHSET=[${PATH:+yes}]'
        ],
        cwd: process.cwd(),
        env: {}
      })
      await waitFor(() => out.includes('PATHSET='))
      expect(out).toContain('ADDR=[]')
      expect(out).toContain('TOK=[]')
      expect(out).toContain('LOGIN=[]')
      expect(out).toContain('TASK=[]')
      expect(out).toContain('FUT=[]')
      expect(out).toContain('ERAN=[]')
      expect(out).toContain('PATHSET=[yes]')
      pty.disposeAll()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('WITHOUT agentHookUrl, passes env through byte-identically (no overlay, no strip)', async () => {
    // Pre-init / tests: the relay port is not yet bound → no agentHookUrl. The
    // env must be passed through UNCHANGED so this stays a no-op seam (behavior
    // identical to before the split existed).
    const { ctx } = makeCtx()
    let out = ''
    const dialer: ComputerDialer = {
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

// ===========================================================================
// Session lifecycle owned by the computer
// ===========================================================================
//
// The computer is the only side that sees a session's output directly, and the
// only side whose view survives a dropped hub connection. So it owns the startup
// deadline (the hub judged silence across a socket and, after a hub stall, killed
// agents whose output was already waiting), it remembers exits (a hub that was
// away used to guess "code 1"), and it answers a repeated spawn of the same
// attempt with the process it already started (the hub re-sends spawns whose
// reply was lost).

type SpawnResult = { pid: number; startupDeadline?: true }
type ListResult = {
  sessions: Array<{ sessionId: string; spawnId?: string; pid: number; seq: number }>
  exited?: Array<{
    sessionId: string
    spawnId?: string
    pid?: number
    exitCode: number | null
    signal: string | null
    reason?: string
  }>
}

const exitOf = (notifies: Notify[], sessionId: string): Record<string, unknown> | undefined =>
  notifies.find((n) => n.method === 'pty.exit' && n.params.sessionId === sessionId)?.params

describe('computer-owned session lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('startup deadline: a session that prints nothing is killed, and the exit says why', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)

    const spawned = (await pty.handlers['pty.spawn']({
      sessionId: 'silent',
      spawnId: 'attempt-1',
      command: 'sleep',
      args: ['30'],
      cwd: process.cwd(),
      startupTimeoutMs: 300
    })) as SpawnResult
    // Acknowledged, so the hub knows not to run a second deadline of its own.
    expect(spawned.startupDeadline).toBe(true)

    await waitFor(() => exitOf(notifies, 'silent') !== undefined)
    expect(exitOf(notifies, 'silent')!.reason).toBe('startup-timeout')
    pty.disposeAll()
  })

  it('startup deadline: any output clears it for good', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)

    await pty.handlers['pty.spawn']({
      sessionId: 'talks',
      spawnId: 'attempt-1',
      command: 'sh',
      args: ['-c', 'printf ready; exec sleep 30'],
      cwd: process.cwd(),
      startupTimeoutMs: 300
    })
    await new Promise((r) => setTimeout(r, 900))

    expect(exitOf(notifies, 'talks')).toBeUndefined()
    pty.disposeAll()
  })

  it('no startupTimeoutMs ⇒ no deadline and no acknowledgement (an older hub runs its own)', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)

    const spawned = (await pty.handlers['pty.spawn']({
      sessionId: 'legacy',
      command: 'sleep',
      args: ['30'],
      cwd: process.cwd()
    })) as SpawnResult
    await new Promise((r) => setTimeout(r, 500))

    expect(spawned.startupDeadline).toBeUndefined()
    expect(exitOf(notifies, 'legacy')).toBeUndefined()
    pty.disposeAll()
  })

  it('a repeated spawn of the SAME attempt returns the running process instead of a second one', async () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    const params = { sessionId: 'dup', spawnId: 'attempt-1', command: 'cat', cwd: process.cwd() }

    const first = (await pty.handlers['pty.spawn'](params)) as SpawnResult
    const again = (await pty.handlers['pty.spawn'](params)) as SpawnResult

    expect(again.pid).toBe(first.pid)
    const listed = (await pty.handlers['pty.list']({})) as ListResult
    expect(listed.sessions).toEqual([
      { sessionId: 'dup', spawnId: 'attempt-1', pid: first.pid, seq: expect.any(Number) }
    ])
    pty.disposeAll()
  })

  it('a DIFFERENT attempt under the same session id still replaces the old process', async () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)

    const first = (await pty.handlers['pty.spawn']({
      sessionId: 'reused',
      spawnId: 'attempt-1',
      command: 'cat',
      cwd: process.cwd()
    })) as SpawnResult
    const second = (await pty.handlers['pty.spawn']({
      sessionId: 'reused',
      spawnId: 'attempt-2',
      command: 'cat',
      cwd: process.cwd()
    })) as SpawnResult

    expect(second.pid).not.toBe(first.pid)
    const listed = (await pty.handlers['pty.list']({})) as ListResult
    expect(listed.sessions.map((s) => s.spawnId)).toEqual(['attempt-2'])
    pty.disposeAll()
  })

  it('an exit is remembered: pty.list reports the REAL code as a tombstone', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)

    const spawned = (await pty.handlers['pty.spawn']({
      sessionId: 'quits',
      spawnId: 'attempt-1',
      command: 'sh',
      args: ['-c', 'exit 3'],
      cwd: process.cwd()
    })) as SpawnResult
    await waitFor(() => exitOf(notifies, 'quits') !== undefined)

    const listed = (await pty.handlers['pty.list']({})) as ListResult
    expect(listed.sessions).toEqual([])
    // Byte-for-byte the exit that was reported live (node-pty's signal included),
    // so the hub settles a missed exit exactly as it would have the live one.
    const delivered = exitOf(notifies, 'quits')!
    expect(listed.exited).toEqual([
      {
        sessionId: 'quits',
        spawnId: 'attempt-1',
        pid: spawned.pid,
        exitCode: 3,
        signal: delivered.signal
      }
    ])
    pty.disposeAll()
  })

  it('re-spawning an attempt that already ran and exited is refused, never run twice', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    const params = {
      sessionId: 'once',
      spawnId: 'attempt-1',
      command: 'sh',
      args: ['-c', 'exit 0'],
      cwd: process.cwd()
    }
    await pty.handlers['pty.spawn'](params)
    await waitFor(() => exitOf(notifies, 'once') !== undefined)

    await expect(Promise.resolve().then(() => pty.handlers['pty.spawn'](params))).rejects.toThrow(
      /already ran/
    )
    pty.disposeAll()
  })

  it('an exit the hub could NOT receive keeps its output for replay', async () => {
    // The hub is away: the exit and the output before it were never delivered.
    // On reconnect the hub backfills from its last seq, so the tombstone keeps
    // the buffer — the tail is often the line saying WHY the agent exited.
    const { ctx } = makeCtx({ online: false })
    const pty = createPtyHandlers(ctx)

    await pty.handlers['pty.spawn']({
      sessionId: 'offline',
      spawnId: 'attempt-1',
      command: 'sh',
      args: ['-c', 'printf "bye from the agent"; exit 4'],
      cwd: process.cwd()
    })
    await waitFor(() => {
      const listed = pty.handlers['pty.list']({}) as ListResult
      return listed.sessions.length === 0
    })

    const replay = (await pty.handlers['pty.getBufferSince']({
      sessionId: 'offline',
      seq: -1
    })) as { frames: Array<{ seq: number; data: string }> }
    expect(replay.frames.map((f) => f.data).join('')).toContain('bye from the agent')
    const listed = (await pty.handlers['pty.list']({})) as ListResult
    expect(listed.exited?.[0]).toMatchObject({ sessionId: 'offline', exitCode: 4 })
    pty.disposeAll()
  })

  it('tombstones expire after the hub could have stopped waiting for them', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    await pty.handlers['pty.spawn']({
      sessionId: 'old',
      spawnId: 'attempt-1',
      command: 'sh',
      args: ['-c', 'exit 0'],
      cwd: process.cwd()
    })
    await waitFor(() => exitOf(notifies, 'old') !== undefined)
    expect(((await pty.handlers['pty.list']({})) as ListResult).exited).toHaveLength(1)

    // Past the hub's 10-minute detach grace: no hub can still be waiting on it.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 11 * 60_000)

    expect(((await pty.handlers['pty.list']({})) as ListResult).exited).toEqual([])
    pty.disposeAll()
  })
})

// ===========================================================================
// Agent-start admission
// ===========================================================================
//
// Restoring a workspace used to start every open tab's agent at once; under that
// contention each took ~10s to print anything and many hit the startup deadline.
// A spawn sent with `admission` now waits for a slot in the computer's admission
// queue. Everything the hub does with the session meanwhile must still land.

describe('agent-start admission', () => {
  const cwd = process.cwd()
  /** One slot, held until first output (no cap in test time), quick warm quiet. */
  const oneSlot = () =>
    createSpawnAdmission({ concurrency: 1, startCapMs: 60_000, warmQuietMs: 50 })
  const outputOf = (notifies: Notify[], sessionId: string): string =>
    notifies
      .filter((n) => n.method === 'pty.data' && n.params.sessionId === sessionId)
      .map((n) => n.params.data as string)
      .join('')
  /** Holds the only slot until it prints `ready` (after `delayS`). */
  const holder = (sessionId: string, delayS = 0.4) => ({
    sessionId,
    admission: 'background',
    command: 'sh',
    args: ['-c', `sleep ${String(delayS)}; printf ready; exec cat`],
    cwd
  })
  const settled = (p: Promise<unknown>) => {
    const state = { done: false, value: undefined as unknown, error: undefined as unknown }
    p.then(
      (v) => Object.assign(state, { done: true, value: v }),
      (e) => Object.assign(state, { done: true, error: e })
    )
    return state
  }

  it('a queued spawn starts when the slot frees, and gets the input sent while it waited', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx, undefined, { admission: oneSlot() })

    const first = settled(pty.handlers['pty.spawn'](holder('first')) as Promise<unknown>)
    const second = settled(
      pty.handlers['pty.spawn']({
        sessionId: 'second',
        admission: 'foreground',
        command: 'cat',
        cwd
      }) as Promise<unknown>
    )
    await waitFor(() => first.done)
    expect((first.value as SpawnResult).pid).toBeGreaterThan(0)

    // Waiting: no process, not listed, but input is kept rather than dropped.
    await pty.handlers['pty.write']({ sessionId: 'second', data: 'typed-while-queued\n' })
    await new Promise((r) => setTimeout(r, 100))
    expect(second.done).toBe(false)
    const listed = (await pty.handlers['pty.list']({})) as ListResult
    expect(listed.sessions.map((s) => s.sessionId)).toEqual(['first'])

    // First output frees the slot; the queued spawn starts and the input lands.
    await waitFor(() => second.done)
    expect(outputOf(notifies, 'first')).toContain('ready')
    expect((second.value as SpawnResult).pid).toBeGreaterThan(0)
    await waitFor(() => outputOf(notifies, 'second').includes('typed-while-queued'))
    pty.disposeAll()
  })

  it('the startup deadline counts from the start, not from the queue', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx, undefined, { admission: oneSlot() })
    void pty.handlers['pty.spawn'](holder('holder', 0.6))
    // Queued for ~600ms with a 300ms deadline: counted from the queue, it would be
    // killed before it ever ran.
    const queued = pty.handlers['pty.spawn']({
      sessionId: 'queued',
      admission: 'background',
      startupTimeoutMs: 300,
      command: 'sh',
      args: ['-c', 'printf alive; exec cat'],
      cwd
    }) as Promise<SpawnResult>
    expect((await queued).startupDeadline).toBe(true)
    await waitFor(() => outputOf(notifies, 'queued').includes('alive'))
    await new Promise((r) => setTimeout(r, 400))
    expect(exitOf(notifies, 'queued')).toBeUndefined()
    pty.disposeAll()
  })

  it('a resize while queued sets the size it starts at', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx, undefined, { admission: oneSlot() })
    void pty.handlers['pty.spawn'](holder('holder'))
    const sized = pty.handlers['pty.spawn']({
      sessionId: 'sized',
      admission: 'background',
      command: 'sh',
      args: ['-c', 'stty size; exec cat'],
      cwd,
      cols: 80,
      rows: 24
    }) as Promise<SpawnResult>
    await pty.handlers['pty.resize']({ sessionId: 'sized', cols: 133, rows: 41 })
    await sized
    await waitFor(() => outputOf(notifies, 'sized').includes('41 133'))
    pty.disposeAll()
  })

  it('a kill while queued: it never runs, and ends with an exit like a killed process', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx, undefined, { admission: oneSlot() })
    void pty.handlers['pty.spawn'](holder('holder'))
    const doomed = settled(
      pty.handlers['pty.spawn']({
        sessionId: 'doomed',
        spawnId: 'attempt-1',
        admission: 'background',
        command: 'cat',
        cwd
      }) as Promise<unknown>
    )
    await pty.handlers['pty.kill']({ sessionId: 'doomed' })
    expect(exitOf(notifies, 'doomed')).toMatchObject({
      exitCode: null,
      reason: 'killed-before-start'
    })
    await waitFor(() => doomed.done)
    expect(doomed.error).toBeInstanceOf(Error)
    // Remembered like any exit, so a hub that missed it settles it on reconnect.
    const listed = (await pty.handlers['pty.list']({})) as ListResult
    expect(listed.exited).toContainEqual(
      expect.objectContaining({ sessionId: 'doomed', spawnId: 'attempt-1' })
    )
    await waitFor(() => outputOf(notifies, 'holder').includes('ready'))
    await new Promise((r) => setTimeout(r, 100))
    expect(listed.sessions.map((s) => s.sessionId)).not.toContain('doomed')
    expect(
      ((await pty.handlers['pty.list']({})) as ListResult).sessions.map((s) => s.sessionId)
    ).toEqual(['holder'])
    pty.disposeAll()
  })

  it('prioritize: the revealed tab starts next', async () => {
    const { notifies, ctx } = makeCtx()
    const pty = createPtyHandlers(ctx, undefined, { admission: oneSlot() })
    void pty.handlers['pty.spawn'](holder('holder'))
    const order: string[] = []
    for (const id of ['bg-1', 'bg-2']) {
      void (
        pty.handlers['pty.spawn']({
          sessionId: id,
          admission: 'background',
          command: 'sh',
          args: ['-c', `printf ${id}; exec cat`],
          cwd
        }) as Promise<unknown>
      ).then(() => order.push(id))
    }
    expect(await pty.handlers['pty.prioritize']({ sessionId: 'bg-2' })).toEqual({
      ok: true,
      queued: true
    })
    await waitFor(() => order.length === 2)
    expect(order).toEqual(['bg-2', 'bg-1'])
    // Started already: nothing to move.
    expect(await pty.handlers['pty.prioritize']({ sessionId: 'bg-2' })).toEqual({
      ok: true,
      queued: false
    })
    await waitFor(() => outputOf(notifies, 'bg-1').includes('bg-1'))
    pty.disposeAll()
  })

  it('the hub re-sending a queued attempt (lost reply) is answered by the one start', async () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx, undefined, { admission: oneSlot() })
    void pty.handlers['pty.spawn'](holder('holder'))
    const spec = { sessionId: 'dup', spawnId: 'a1', admission: 'background', command: 'cat', cwd }
    const a = pty.handlers['pty.spawn'](spec) as Promise<SpawnResult>
    const b = pty.handlers['pty.spawn'](spec) as Promise<SpawnResult>
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.pid).toBe(rb.pid)
    pty.disposeAll()
  })

  it('a hub disconnect drops queued spawns: they never run (the hub re-sends what it still wants)', async () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx, undefined, { admission: oneSlot() })
    void pty.handlers['pty.spawn'](holder('holder', 0.2))
    const lost = settled(
      pty.handlers['pty.spawn']({
        sessionId: 'lost',
        admission: 'background',
        command: 'cat',
        cwd
      }) as Promise<unknown>
    )
    pty.dropQueued('hub disconnected')
    await waitFor(() => lost.done)
    expect(lost.error).toBeInstanceOf(Error)
    await new Promise((r) => setTimeout(r, 400))
    expect(
      ((await pty.handlers['pty.list']({})) as ListResult).sessions.map((s) => s.sessionId)
    ).toEqual(['holder'])
    pty.disposeAll()
  })

  it('a spawn WITHOUT admission (plain shell, older hub) starts at once, even with the queue full', async () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx, undefined, { admission: oneSlot() })
    void pty.handlers['pty.spawn'](holder('holder'))
    const shell = pty.handlers['pty.spawn']({ sessionId: 'shell', command: 'cat', cwd })
    expect((shell as SpawnResult).pid).toBeGreaterThan(0)
    pty.disposeAll()
  })

  it('the warm pool waits until no agent is starting', async () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx, undefined, { admission: oneSlot() })
    void pty.handlers['pty.spawn'](holder('agent', 0.3))
    const warm = settled(
      pty.handlers['pty.warmSpawn']({ warmId: 'warm-1', command: 'cat', cwd }) as Promise<unknown>
    )
    await new Promise((r) => setTimeout(r, 150))
    expect(warm.done).toBe(false)
    expect((pty.handlers['pty.warmList']({}) as { warms: unknown[] }).warms).toEqual([])
    // Agent prints (t≈300ms) → slot free → quiet period (50ms) → warm boots.
    await waitFor(() => warm.done)
    expect((warm.value as { pid: number }).pid).toBeGreaterThan(0)
    expect((pty.handlers['pty.warmList']({}) as { warms: unknown[] }).warms).toHaveLength(1)
    pty.disposeAll()
  })

  it("warm agents boot one at a time: a warm start keeps its slot past its shell's first output", async () => {
    // The shell prints first; the agent it execs boots after that. Releasing on
    // that first output would let the whole pool boot at once.
    const { ctx } = makeCtx()
    const admission = createSpawnAdmission({ concurrency: 4, startCapMs: 400, warmQuietMs: 0 })
    const pty = createPtyHandlers(ctx, undefined, { admission })
    const spec = (warmId: string) => ({
      warmId,
      command: 'sh',
      args: ['-c', 'printf prompt; exec cat'],
      cwd
    })
    const t0 = Date.now()
    await pty.handlers['pty.warmSpawn'](spec('w1'))
    await pty.handlers['pty.warmSpawn'](spec('w2'))
    expect(Date.now() - t0).toBeGreaterThanOrEqual(380)
    pty.disposeAll()
  })

  it('warmKill of a still-queued warm agent: it never boots', async () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx, undefined, { admission: oneSlot() })
    void pty.handlers['pty.spawn'](holder('agent', 0.2))
    const warm = settled(
      pty.handlers['pty.warmSpawn']({ warmId: 'warm-x', command: 'cat', cwd }) as Promise<unknown>
    )
    await pty.handlers['pty.warmKill']({ warmId: 'warm-x' })
    await waitFor(() => warm.done)
    expect(warm.error).toBeInstanceOf(Error)
    await new Promise((r) => setTimeout(r, 500))
    expect((pty.handlers['pty.warmList']({}) as { warms: unknown[] }).warms).toEqual([])
    pty.disposeAll()
  })
})

describe('a spawn node-pty cannot start', () => {
  // node-pty says only "posix_spawnp failed." — it cannot exec its own
  // spawn-helper. The usual cause is an install that skipped its scripts and left
  // the helper non-executable, so the refusal carries what the install check finds.
  const refuse = (): never => {
    throw new Error('posix_spawnp failed.')
  }
  const helperProblem = {
    check: 'spawn-helper',
    detail: '/nm/node-pty/prebuilds/darwin-arm64/spawn-helper is not executable.',
    fix: "chmod +x '/nm/node-pty/prebuilds/darwin-arm64/spawn-helper'"
  }

  it('is refused with the install problem and its fix', () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx, undefined, {
      spawnPty: refuse,
      nodePtyInstallProblems: () => [helperProblem]
    })
    let message = ''
    try {
      pty.handlers['pty.spawn']({ sessionId: 's-refused', command: 'cat', cwd: process.cwd() })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toBe(`posix_spawnp failed. ${helperProblem.detail} Fix: ${helperProblem.fix}`)
  })

  it("keeps node-pty's own message when the install is fine", () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx, undefined, {
      spawnPty: refuse,
      nodePtyInstallProblems: () => []
    })
    expect(() =>
      pty.handlers['pty.spawn']({ sessionId: 's-refused', command: 'cat', cwd: process.cwd() })
    ).toThrow(/^posix_spawnp failed\.$/)
  })

  it('a warm spawn is explained the same way', async () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx, undefined, {
      spawnPty: refuse,
      nodePtyInstallProblems: () => [helperProblem]
    })
    await expect(
      pty.handlers['pty.warmSpawn']({ warmId: 'w-refused', command: 'cat', cwd: process.cwd() })
    ).rejects.toThrow(/Fix: chmod \+x/)
  })
})

describe('pty.runtimeCheck (Doctor)', () => {
  it("reports the install check's problems", async () => {
    const { ctx } = makeCtx()
    const problem = { check: 'Install scripts', detail: 'pnpm skipped …', fix: 'pnpm rebuild' }
    const pty = createPtyHandlers(ctx, undefined, { nodePtyInstallProblems: () => [problem] })
    expect(await pty.handlers['pty.runtimeCheck']({})).toEqual({ ok: true, problems: [problem] })
  })

  it('finds the node-pty this computer loads: this checkout is healthy', async () => {
    const { ctx } = makeCtx()
    const pty = createPtyHandlers(ctx)
    expect(await pty.handlers['pty.runtimeCheck']({})).toEqual({ ok: true, problems: [] })
  })
})
