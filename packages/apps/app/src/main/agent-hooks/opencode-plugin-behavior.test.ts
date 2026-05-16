import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath, pathToFileURL } from 'url'
import { describe, test, expect, beforeEach, vi } from 'vitest'

// Resolve plugin source from repo (not via Vite `?raw` — this test runs under
// vitest directly and we need to mutate {{NOTIFY_PATH}} per test fixture).
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_SRC = path.resolve(HERE, '../../../../../shared/hooks/src/opencode-plugin.js')

interface ShellCall {
  cmd: string
}

interface MockedHandlers {
  event: (e: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void>
  'permission.ask': (permission: unknown, output: { status: string }) => Promise<void>
}

async function loadPlugin(opts: { notifyPath?: string; taskId?: string | null } = {}): Promise<{
  handlers: MockedHandlers
  shellCalls: ShellCall[]
  listCalls: number
  sessions: { data: { id: string; parentID?: string }[] }
}> {
  const notifyPath = opts.notifyPath ?? '/abs/notify.sh'
  const src = fs.readFileSync(PLUGIN_SRC, 'utf8').split('{{NOTIFY_PATH}}').join(notifyPath)

  const tmpFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-test-')),
    `plugin-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
  )
  fs.writeFileSync(tmpFile, src)

  // Reset singleton guard so each load runs the plugin body.
  ;(globalThis as Record<string, unknown>).__slayzoneOpencodePluginV1 = false
  if (opts.taskId === null) {
    delete process.env.SLAYZONE_TASK_ID
  } else {
    process.env.SLAYZONE_TASK_ID = opts.taskId ?? 'task-123'
  }

  const mod = (await import(pathToFileURL(tmpFile).href)) as {
    SlayzoneNotifyPlugin: (ctx: {
      $: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<void>
      client: { session: { list: () => Promise<{ data: { id: string; parentID?: string }[] }> } }
    }) => Promise<unknown>
  }

  const shellCalls: ShellCall[] = []
  const $ = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    let cmd = ''
    strings.forEach((s, i) => {
      cmd += s
      if (i < vals.length) cmd += String(vals[i])
    })
    shellCalls.push({ cmd })
    return Promise.resolve()
  }

  const sessions: { data: { id: string; parentID?: string }[] } = { data: [] }
  let listCalls = 0
  const client = {
    session: {
      list: async () => {
        listCalls++
        return sessions
      },
    },
  }

  const handlers = (await mod.SlayzoneNotifyPlugin({ $, client })) as MockedHandlers
  return {
    handlers,
    shellCalls,
    get listCalls() {
      return listCalls
    },
    sessions,
  }
}

function hookEvents(shellCalls: ShellCall[]): string[] {
  return shellCalls
    .map((c) => {
      const m = c.cmd.match(/"hook_event_name":"([^"]+)"/)
      return m ? m[1] : null
    })
    .filter((e): e is string => e !== null)
}

describe('opencode plugin behavior', () => {
  beforeEach(() => {
    process.env.SLAYZONE_TASK_ID = 'task-123'
    ;(globalThis as Record<string, unknown>).__slayzoneOpencodePluginV1 = false
  })

  test('no-op (empty handler object) when SLAYZONE_TASK_ID is unset', async () => {
    const { handlers } = await loadPlugin({ taskId: null })
    expect(handlers).toEqual({})
  })

  test('session.created w/o parentID fires SessionStart', async () => {
    const p = await loadPlugin()
    await p.handlers.event({ event: { type: 'session.created', properties: { info: { id: 's1' } } } })
    expect(hookEvents(p.shellCalls)).toEqual(['SessionStart'])
  })

  test('session.created w/ parentID does NOT fire SessionStart (child)', async () => {
    const p = await loadPlugin()
    await p.handlers.event({
      event: { type: 'session.created', properties: { info: { id: 's-child', parentID: 's-root' } } },
    })
    expect(p.shellCalls).toEqual([])
  })

  test('session.deleted resolves child-ness from cache (no list() call)', async () => {
    const p = await loadPlugin()
    // Seed cache via session.created.
    await p.handlers.event({ event: { type: 'session.created', properties: { info: { id: 's1' } } } })
    const before = p.listCalls
    await p.handlers.event({ event: { type: 'session.deleted', properties: { info: { id: 's1' } } } })
    expect(p.listCalls).toBe(before)
    expect(hookEvents(p.shellCalls)).toEqual(['SessionStart', 'SessionEnd'])
  })

  test('idle→busy fires Start once; busy→busy is a no-op', async () => {
    const p = await loadPlugin()
    p.sessions.data.push({ id: 's1' })
    await p.handlers.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } },
    })
    await p.handlers.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } },
    })
    expect(hookEvents(p.shellCalls)).toEqual(['Start'])
  })

  test('busy→idle fires Stop once; idle→idle is a no-op', async () => {
    const p = await loadPlugin()
    p.sessions.data.push({ id: 's1' })
    await p.handlers.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } },
    })
    await p.handlers.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
    })
    await p.handlers.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
    })
    expect(hookEvents(p.shellCalls)).toEqual(['Start', 'Stop'])
  })

  test('child session status events are ignored entirely', async () => {
    const p = await loadPlugin()
    p.sessions.data.push({ id: 'child', parentID: 'root' })
    await p.handlers.event({
      event: { type: 'session.status', properties: { sessionID: 'child', status: { type: 'busy' } } },
    })
    await p.handlers.event({
      event: { type: 'session.status', properties: { sessionID: 'child', status: { type: 'idle' } } },
    })
    expect(p.shellCalls).toEqual([])
  })

  test('client.session.list() error → assume child → no notify', async () => {
    const p = await loadPlugin()
    p.sessions.data.push({ id: 's1' })
    // Override list to throw.
    const overrideHandlers = p.handlers
    Object.defineProperty(p, 'sessions', { value: undefined, writable: true, configurable: true })
    // Re-load with throwing list.
    const src = fs.readFileSync(PLUGIN_SRC, 'utf8').split('{{NOTIFY_PATH}}').join('/n.sh')
    const tmpFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-test-')),
      `plugin-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
    )
    fs.writeFileSync(tmpFile, src)
    ;(globalThis as Record<string, unknown>).__slayzoneOpencodePluginV1 = false
    const mod = (await import(pathToFileURL(tmpFile).href)) as {
      SlayzoneNotifyPlugin: (ctx: unknown) => Promise<MockedHandlers>
    }
    const shellCalls: ShellCall[] = []
    const $ = (strings: TemplateStringsArray, ...vals: unknown[]) => {
      let cmd = ''
      strings.forEach((s, i) => {
        cmd += s
        if (i < vals.length) cmd += String(vals[i])
      })
      shellCalls.push({ cmd })
      return Promise.resolve()
    }
    const client = { session: { list: () => Promise.reject(new Error('boom')) } }
    const handlers = await mod.SlayzoneNotifyPlugin({ $, client })
    await handlers.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } },
    })
    expect(shellCalls).toEqual([])
    void overrideHandlers
  })

  test('after Stop, new busy on different session fires fresh Start (rootSessionID resets)', async () => {
    const p = await loadPlugin()
    p.sessions.data.push({ id: 's1' }, { id: 's2' })
    await p.handlers.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } },
    })
    await p.handlers.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } },
    })
    await p.handlers.event({
      event: { type: 'session.status', properties: { sessionID: 's2', status: { type: 'busy' } } },
    })
    expect(hookEvents(p.shellCalls)).toEqual(['Start', 'Stop', 'Start'])
  })

  test('legacy session.busy/session.idle top-level events handled (backwards-compat)', async () => {
    const p = await loadPlugin()
    p.sessions.data.push({ id: 's1' })
    await p.handlers.event({ event: { type: 'session.busy', properties: { sessionID: 's1' } } })
    await p.handlers.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } })
    expect(hookEvents(p.shellCalls)).toEqual(['Start', 'Stop'])
  })

  test('session.error during busy fires Stop', async () => {
    const p = await loadPlugin()
    p.sessions.data.push({ id: 's1' })
    await p.handlers.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } },
    })
    await p.handlers.event({ event: { type: 'session.error', properties: { sessionID: 's1' } } })
    expect(hookEvents(p.shellCalls)).toEqual(['Start', 'Stop'])
  })

  test('permission.ask w/ status=ask fires PermissionRequest', async () => {
    const p = await loadPlugin()
    await p.handlers['permission.ask']({}, { status: 'ask' })
    expect(hookEvents(p.shellCalls)).toEqual(['PermissionRequest'])
  })

  test('permission.ask w/ non-ask status is a no-op', async () => {
    const p = await loadPlugin()
    await p.handlers['permission.ask']({}, { status: 'allow' })
    expect(p.shellCalls).toEqual([])
  })

  test('Start shell call uses substituted notify path', async () => {
    const p = await loadPlugin({ notifyPath: '/custom/notify.sh' })
    p.sessions.data.push({ id: 's1' })
    await p.handlers.event({
      event: { type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } },
    })
    expect(p.shellCalls[0]?.cmd).toContain('/custom/notify.sh')
  })

  test('singleton guard prevents double-load', async () => {
    const p1 = await loadPlugin()
    expect(p1.handlers).toBeDefined()
    // Don't reset the global flag — second load should hit the guard.
    process.env.SLAYZONE_TASK_ID = 'task-123'
    const src = fs.readFileSync(PLUGIN_SRC, 'utf8').split('{{NOTIFY_PATH}}').join('/n.sh')
    const tmpFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-test-')),
      `plugin-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
    )
    fs.writeFileSync(tmpFile, src)
    const mod = (await import(pathToFileURL(tmpFile).href)) as {
      SlayzoneNotifyPlugin: (ctx: unknown) => Promise<unknown>
    }
    const $ = vi.fn()
    const client = { session: { list: async () => ({ data: [] }) } }
    const second = await mod.SlayzoneNotifyPlugin({ $, client })
    expect(second).toEqual({})
  })
})
