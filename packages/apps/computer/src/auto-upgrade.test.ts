import { describe, expect, it, vi } from 'vitest'
import { createUpgradeController, type UpgradeWorker } from './auto-upgrade'

function setup() {
  let hub = '1.0.0'
  let idle = true
  let failInstall = false
  let failConnect = false
  const events: string[] = []
  const worker = (version: string): UpgradeWorker => ({
    drain: async () => {
      events.push(`drain:${version}`)
      return idle
    },
    stop: async () => {
      events.push(`stop:${version}`)
    },
    connected: async () => {
      if (failConnect && version === '2.0.0') throw Error('protocol mismatch')
    }
  })
  const deps = {
    discover: async () => hub,
    install: vi.fn(async (version: string) => {
      events.push(`install:${version}`)
      if (failInstall) throw Error('registry unavailable')
      return `/runtime/${version}/bin.cjs`
    }),
    launch: vi.fn((entry: string) => {
      events.push(`launch:${entry}`)
      return worker(entry.includes('2.0.0') ? '2.0.0' : '1.0.0')
    }),
    commit: vi.fn(async () => {}),
    probationMs: 0,
    now: () => 1000,
    retry: false,
    status: vi.fn()
  }
  const controller = createUpgradeController(
    { version: '1.0.0', entry: '/original/bin.cjs', worker: worker('1.0.0') },
    deps
  )
  return {
    controller,
    deps,
    events,
    hub: (v: string) => {
      hub = v
    },
    idle: (v: boolean) => {
      idle = v
    },
    failInstall: (v: boolean) => {
      failInstall = v
    },
    failConnect: (v: boolean) => {
      failConnect = v
    }
  }
}

describe('standalone computer hub-release upgrades', () => {
  it('upgrades to exact hub release and commits only after reconnection', async () => {
    const s = setup()
    await s.controller.check()
    expect(s.deps.install).not.toHaveBeenCalled()
    s.hub('2.0.0') // Discovery works even when the computer protocol rejects hello.
    await s.controller.check()
    expect(s.events).toEqual([
      'install:2.0.0',
      'drain:1.0.0',
      'stop:1.0.0',
      'launch:/runtime/2.0.0/bin.cjs'
    ])
    expect(s.deps.commit).toHaveBeenCalledWith(
      {
        version: '2.0.0',
        entry: '/runtime/2.0.0/bin.cjs'
      },
      { version: '1.0.0', entry: '/original/bin.cjs' }
    )
    await s.controller.check()
    expect(s.deps.install).toHaveBeenCalledTimes(1)
  })

  it('stages during active work, defers restart until safe, reuses staged release', async () => {
    const s = setup()
    s.hub('2.0.0')
    s.idle(false)
    await s.controller.check()
    expect(s.events).toEqual(['install:2.0.0', 'drain:1.0.0'])
    s.idle(true)
    await s.controller.check()
    expect(s.deps.install).toHaveBeenCalledTimes(1)
    expect(s.deps.commit).toHaveBeenCalledTimes(1)
  })

  it('retries failed installs without stopping old worker', async () => {
    const s = setup()
    s.hub('2.0.0')
    s.failInstall(true)
    await s.controller.check()
    expect(s.events).toEqual(['install:2.0.0'])
    expect(s.deps.status).toHaveBeenLastCalledWith(
      'failed',
      expect.objectContaining({ error: 'registry unavailable' })
    )
    s.failInstall(false)
    await s.controller.check()
    expect(s.deps.commit).toHaveBeenCalledTimes(1)
  })

  it('rolls back failed reconnect, then retries successfully', async () => {
    const s = setup()
    s.hub('2.0.0')
    s.failConnect(true)
    await s.controller.check()
    expect(s.deps.commit).not.toHaveBeenCalled()
    expect(s.events.slice(-2)).toEqual(['stop:2.0.0', 'launch:/original/bin.cjs'])
    s.failConnect(false)
    await s.controller.check()
    expect(s.deps.commit).toHaveBeenCalledTimes(1)
  })

  it('serializes overlapping checks', async () => {
    const s = setup()
    s.hub('2.0.0')
    await Promise.all([s.controller.check(), s.controller.check()])
    expect(s.deps.install).toHaveBeenCalledTimes(1)
  })
  it('stop during candidate startup stops candidate without relaunching old worker', async () => {
    const s = setup()
    s.hub('2.0.0')
    let candidateStarted!: () => void
    const started = new Promise<void>((r) => {
      candidateStarted = r
    })
    let failConnect!: (err: Error) => void
    const candidateStop = vi.fn(async () => {
      failConnect(Error('stopped'))
    })
    s.deps.launch.mockImplementationOnce(() => ({
      drain: async () => true,
      stop: candidateStop,
      connected: () => {
        candidateStarted()
        return new Promise<void>((_r, reject) => {
          failConnect = reject
        })
      }
    }))
    const check = s.controller.check()
    await started
    await s.controller.stop()
    expect(candidateStop).toHaveBeenCalled()
    await check
    expect(s.deps.launch).toHaveBeenCalledTimes(1)
    expect(s.deps.commit).not.toHaveBeenCalled()
  })
  it('rolls back a committed release after three startup crashes', async () => {
    let crashed = false
    const old = {
      drain: async () => true,
      stop: async () => {},
      connected: async () => {},
      exited: () => false
    }
    const launches: string[] = []
    const c = createUpgradeController(
      { version: '1', entry: 'old', worker: old },
      {
        discover: async () => '2',
        install: async () => 'new',
        launch: (entry) => {
          launches.push(entry)
          return { ...old, exited: () => entry === 'new' && crashed }
        },
        commit: async () => {},
        status: () => {},
        probationMs: 0
      }
    )
    await c.check()
    crashed = true
    await c.check()
    await c.check()
    await c.check()
    expect(launches.at(-1)).toBe('old')
    await c.stop()
  })
})

it('defers incompatible host contracts before stopping the current connector', async () => {
  const s = setup()
  s.hub('2.0.0')
  const { HostMaintenanceRequired } = await import('./auto-upgrade')
  const deps = {
    ...s.deps,
    validate: async () => {
      throw new HostMaintenanceRequired('host contract 2 required')
    }
  }
  const stop = vi.fn(async () => {})
  const controller = createUpgradeController(
    {
      version: '1.0.0',
      entry: 'old',
      worker: { drain: async () => true, connected: async () => {}, stop }
    },
    deps
  )
  await controller.check()
  expect(stop).not.toHaveBeenCalled()
  expect(deps.status).toHaveBeenLastCalledWith(
    'maintenance-required',
    expect.objectContaining({ target: '2.0.0' })
  )
  await controller.stop()
})

it('retains visible failure and retry deadline while target is cooling down', async () => {
  const status = vi.fn()
  const c = createUpgradeController(
    {
      version: '1',
      entry: 'old',
      worker: { connected: async () => {}, drain: async () => true, stop: async () => {} }
    },
    {
      discover: async () => '2',
      install: async () => {
        throw Error('offline')
      },
      launch: () => {
        throw Error('unreachable')
      },
      commit: async () => {},
      status,
      now: () => 1000
    }
  )
  await c.check()
  const count = status.mock.calls.length
  await c.check()
  expect(status).toHaveBeenCalledTimes(count)
  expect(status).toHaveBeenLastCalledWith(
    'failed',
    expect.objectContaining({ retryAt: expect.any(Number) })
  )
  await c.stop()
})

// A connector stopped between the hub's enrollment reply and saving its credential
// leaves the hub an enrollment nobody holds: its replacement enrolls again (a second
// computer, the join token spent twice). The upgrade waits until it has connected.
it('replaces the running connector only once it has connected (or failed to)', async () => {
  const events: string[] = []
  let enrolled!: () => void
  const enrolling = new Promise<void>((resolve) => (enrolled = resolve))
  const worker = (version: string, connected: () => Promise<void>): UpgradeWorker => ({
    connected,
    drain: async () => {
      events.push(`drain:${version}`)
      return true
    },
    stop: async () => {
      events.push(`stop:${version}`)
    }
  })
  const c = createUpgradeController(
    { version: '1.0.0', entry: '/original/bin.cjs', worker: worker('1.0.0', () => enrolling) },
    {
      discover: async () => '2.0.0',
      install: async () => '/runtime/2.0.0/bin.cjs',
      launch: (entry) => {
        events.push(`launch:${entry}`)
        return worker('2.0.0', async () => {})
      },
      commit: async () => {},
      probationMs: 0,
      retry: false,
      status: () => {}
    }
  )
  const check = c.check()
  // Let discovery and the install run up to where the controller waits on the connector.
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(events).toEqual([])
  enrolled()
  await check
  expect(events).toEqual(['drain:1.0.0', 'stop:1.0.0', 'launch:/runtime/2.0.0/bin.cjs'])

  // A connector that cannot connect at all (its protocol is refused) is replaced at once.
  const refused: string[] = []
  const d = createUpgradeController(
    {
      version: '1.0.0',
      entry: '/original/bin.cjs',
      worker: {
        connected: async () => {
          throw new Error('protocol mismatch')
        },
        drain: async () => true,
        stop: async () => {
          refused.push('stop:1.0.0')
        }
      }
    },
    {
      discover: async () => '2.0.0',
      install: async () => '/runtime/2.0.0/bin.cjs',
      launch: () => worker('2.0.0', async () => {}),
      commit: async () => {
        refused.push('commit:2.0.0')
      },
      probationMs: 0,
      retry: false,
      status: () => {}
    }
  )
  await d.check()
  expect(refused).toEqual(['stop:1.0.0', 'commit:2.0.0'])
})
