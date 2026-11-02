import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  statSync,
  watchFile
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import {
  getComputerConfigFilePath,
  readComputerConfigSnapshot
} from '@slayzone/platform/slayzone-config'
import type { ComputerConfig } from '../config'
import { createFsHandlers } from './fs'
import { HubDialer, type HubDialerOptions } from '@slayzone/computer-transport/client'
import { startComputer } from '../main'
import { createComputerConfigHandlers, reloadLocalRootsFromFile } from './computer-config'
import type { ComputerDialer } from './types'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, watchFile: vi.fn(fs.watchFile) }
})

const dialer: ComputerDialer = { notify: () => true }

let dir: string
let home: string

// `updateComputerConfigFile` resolves its path from the computer ROOT, which derives
// from HOME. Point both at a tmpdir so the test never writes the real config.
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'computer-cfg-')))
  home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('SLAYZONE_ROOT', join(home, 'computer'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function ctxWith(roots: string[]) {
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: roots,
    capabilities: ['fs'],
    // The desktop's own computer (T-27): the only kind that accepts a hub-pushed jail.
    hubMayEditRoots: true
  }
  return { dialer, config, log: () => {} }
}

describe('computer.setAllowedRoots', () => {
  it('canonicalizes, de-duplicates, and persists the new jail', async () => {
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })

    const ctx = ctxWith([a])
    const handlers = createComputerConfigHandlers(ctx)
    const res = (await handlers[HubToComputerMethods.computerSetAllowedRoots]({
      roots: [a, b, b]
    })) as { roots: string[]; rejected: unknown[] }

    expect(res.roots).toEqual([a, b])
    expect(res.rejected).toEqual([])

    const onDisk = JSON.parse(readFileSync(getComputerConfigFilePath(), 'utf-8')) as {
      allowedRoots: string[]
    }
    expect(onDisk.allowedRoots).toEqual([a, b])
  })

  // The whole point of the feature: the widened jail has to bind the ops
  // immediately. The handler modules read `ctx.config.allowedRoots` per call for
  // this reason — a captured array would keep refusing while the UI said saved.
  it('applies live — an op refused before the edit succeeds after it', async () => {
    const inside = join(dir, 'inside')
    const outside = join(dir, 'outside')
    mkdirSync(inside, { recursive: true })
    mkdirSync(outside, { recursive: true })

    const ctx = ctxWith([inside])
    const { handlers: fs } = createFsHandlers(ctx)
    const cfg = createComputerConfigHandlers(ctx)

    expect(() => fs[HubToComputerMethods.fsPathExists]({ path: outside })).toThrow(/allowedRoots/)

    await cfg[HubToComputerMethods.computerSetAllowedRoots]({ roots: [inside, outside] })

    expect(fs[HubToComputerMethods.fsPathExists]({ path: outside })).toEqual({ exists: true })
    // …and the browse surface reports the widened set, so the picker offers it.
    expect((fs[HubToComputerMethods.fsListRoots]({}) as { roots: string[] }).roots).toEqual([
      inside,
      outside
    ])
  })

  it('rejects a relative root and one that does not exist, naming both', async () => {
    const real = join(dir, 'real')
    mkdirSync(real, { recursive: true })
    const handlers = createComputerConfigHandlers(ctxWith([real]))

    const res = (await handlers[HubToComputerMethods.computerSetAllowedRoots]({
      roots: [real, 'relative/path', join(dir, 'ghost')]
    })) as { roots: string[]; rejected: { path: string; reason: string }[] }

    expect(res.roots).toEqual([real])
    expect(res.rejected.map((r) => r.reason)).toEqual([
      'not an absolute path',
      'does not exist on this computer'
    ])
  })

  // `coerceComputerConfig` reads `allowedRoots: []` back as "unset" and falls
  // through to the defaults, so saving an empty set would apply now and silently
  // revert on restart. Refusing is the honest outcome.
  it('refuses an empty result rather than persisting a set that would revert', async () => {
    const real = join(dir, 'real')
    mkdirSync(real, { recursive: true })
    const ctx = ctxWith([real])
    const handlers = createComputerConfigHandlers(ctx)

    // Synchronous throw — the dispatch table awaits handler results, so this
    // still reaches the hub as a rejected request.
    expect(() => handlers[HubToComputerMethods.computerSetAllowedRoots]({ roots: [] })).toThrow(
      /at least one allowed root/
    )
    expect(() =>
      handlers[HubToComputerMethods.computerSetAllowedRoots]({ roots: [join(dir, 'ghost')] })
    ).toThrow(/no usable roots/)

    // The live jail is untouched by a refused edit.
    expect(ctx.config.allowedRoots).toEqual([real])
  })
})

describe('standalone live folder policy', () => {
  function fixture() {
    const root = join(dir, 'computer')
    const wide = join(dir, 'wide')
    mkdirSync(root)
    mkdirSync(wide)
    const path = join(root, 'computer.config.json')
    writeFileSync(join(root, 'config.json'), JSON.stringify({ allowedRoots: [dir] }))
    const config = {
      ...ctxWith([wide]).config,
      capabilities: ['fs', 'proc'],
      hubMayEditRoots: false
    }
    return { root, wide, path, config }
  }

  it.each([{}, { allowedRoots: [] }])(
    'restores ROOT default when valid file removes roots: %j',
    (file) => {
      const { root, wide, path, config } = fixture()
      writeFileSync(path, JSON.stringify(file))
      expect(reloadLocalRootsFromFile(config, path, root)).toEqual([realpathSync.native(root)])
      const fs = createFsHandlers({ config, dialer, log: () => {} }).handlers
      expect(() => fs[HubToComputerMethods.fsPathExists]({ path: wide })).toThrow(/allowedRoots/)
      expect(fs[HubToComputerMethods.fsPathExists]({ path: root })).toEqual({ exists: true })
    }
  )

  it('does not revive legacy wider roots when current file is deleted', () => {
    const { root, path, config } = fixture()
    writeFileSync(path, JSON.stringify({ allowedRoots: config.allowedRoots }))
    unlinkSync(path)
    expect(reloadLocalRootsFromFile(config, path, root)).toEqual([realpathSync.native(root)])
  })

  it('live adoption prevents legacy policy revival on the next boot', () => {
    const { root, path, config } = fixture()
    expect(readComputerConfigSnapshot(path).config.allowedRoots).toEqual([dir])
    writeFileSync(path, JSON.stringify({ allowedRoots: [root] }))
    reloadLocalRootsFromFile(config, path, root)
    unlinkSync(path)
    expect(readComputerConfigSnapshot(path).config).toEqual({})
  })

  it.each([
    '{',
    'null',
    '[]',
    '{"allowedRoots":null}',
    '{"allowedRoots":"/broad"}',
    '{"allowedRoots":[null]}',
    '{"allowedRoots":["relative"]}'
  ])('rejects corrupt/invalid policy without applying legacy fallback: %s', (text) => {
    const { root, wide, path, config } = fixture()
    writeFileSync(path, text)
    expect(() => reloadLocalRootsFromFile(config, path, root)).toThrow(/configuration|allowedRoots/)
    expect(config.allowedRoots).toEqual([wide])
  })

  it('retains current policy when config cannot be read', () => {
    const { root, wide, path, config } = fixture()
    mkdirSync(path)
    expect(() => reloadLocalRootsFromFile(config, path, root)).toThrow(/read.*configuration/)
    expect(config.allowedRoots).toEqual([wide])
  })

  it('live removal narrows future requests while running job survives', async () => {
    const { root, wide, path, config } = fixture()
    writeFileSync(path, JSON.stringify({ allowedRoots: [wide] }))
    let dispatch!: NonNullable<HubDialerOptions['onHubRequest']>
    const log = vi.fn()
    const handle = startComputer(config, {
      stateDir: root,
      log,
      createDialer: (options) => {
        dispatch = options.onHubRequest!
        const dialer = new HubDialer(options)
        vi.spyOn(dialer, 'start').mockImplementation(() => {})
        return dialer
      }
    })
    try {
      const result = (await dispatch(
        'proc.spawn',
        {
          sessionId: 'survivor',
          command: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
          cwd: wide
        },
        { userId: null, route: null }
      )) as { pid: number }
      writeFileSync(path, '{}')
      await vi.waitFor(() => expect(config.allowedRoots).toEqual([realpathSync.native(root)]), {
        timeout: 6000
      })
      expect(() => process.kill(result.pid, 0)).not.toThrow()
      await expect(
        dispatch('fs.pathExists', { path: wide }, { userId: null, route: null })
      ).rejects.toThrow(/allowedRoots/)
      expect(log).toHaveBeenCalledWith('allowedRoots reloaded from local config', {
        applied: [realpathSync.native(root)]
      })
    } finally {
      await handle.stop()
    }
  }, 10000)

  it('preserves legacy-only boot policy before the device file exists', async () => {
    const { root, wide, config } = fixture()
    writeFileSync(join(root, 'config.json'), JSON.stringify({ allowedRoots: [wide] }))
    const handle = startComputer(config, {
      stateDir: root,
      createDialer: (options) => {
        const dialer = new HubDialer(options)
        vi.spyOn(dialer, 'start').mockImplementation(() => {})
        return dialer
      }
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 2200))
      expect(config.allowedRoots).toEqual([wide])
    } finally {
      await handle.stop()
    }
  }, 10000)

  it('logs corrupt live policy and retains current roots instead of legacy roots', async () => {
    const { root, wide, path, config } = fixture()
    writeFileSync(path, JSON.stringify({ allowedRoots: [wide] }))
    // Drive the watcher callback directly: writing synchronously after watchFile
    // can beat its asynchronous initial stat and produce no change event.
    // Actual polling is covered by the live-removal test above.
    const before = statSync(path)
    let changed!: (
      current: ReturnType<typeof statSync>,
      previous: ReturnType<typeof statSync>
    ) => void
    vi.mocked(watchFile).mockImplementationOnce((...args: unknown[]) => {
      changed = args[2] as typeof changed
      return {} as ReturnType<typeof watchFile>
    })
    const log = vi.fn()
    const handle = startComputer(config, {
      stateDir: root,
      log,
      createDialer: (options) => {
        const dialer = new HubDialer(options)
        vi.spyOn(dialer, 'start').mockImplementation(() => {})
        return dialer
      }
    })
    try {
      writeFileSync(path, '{')
      changed(statSync(path), before)
      expect(log).toHaveBeenCalledWith(
        'allowedRoots reload failed; keeping current folder policy',
        expect.objectContaining({ error: expect.any(String) })
      )
      expect(config.allowedRoots).toEqual([wide])
    } finally {
      await handle.stop()
    }
  }, 10000)
})
