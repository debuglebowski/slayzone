import { delimiter } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComputerConfig } from '../config'
import { buildSpawnEnv } from './spawn-env'
import type { HandlerContext } from './types'

function ctxWith(config: Partial<ComputerConfig> = {}): HandlerContext {
  return {
    dialer: { notify: () => true },
    config: {
      hubUrl: 'ws://localhost:0/computers',
      name: 'test',
      allowedRoots: [],
      capabilities: ['proc'],
      ...config
    },
    log: () => {}
  }
}

let savedPath: string | undefined
let savedOverride: string | undefined

beforeEach(() => {
  savedPath = process.env.PATH
  savedOverride = process.env.SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR
})

afterEach(() => {
  process.env.PATH = savedPath
  if (savedOverride === undefined) delete process.env.SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR
  else process.env.SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR = savedOverride
})

describe('buildSpawnEnv — binOverrideDir', () => {
  it('leaves PATH untouched when no override dir is configured', () => {
    process.env.PATH = ['/usr/bin', '/bin'].join(delimiter)
    expect(buildSpawnEnv(ctxWith()).PATH).toBe(process.env.PATH)
  })

  it('puts the override dir first on the inherited PATH', () => {
    process.env.PATH = ['/home/u/.local/bin', '/usr/bin'].join(delimiter)
    const env = buildSpawnEnv(ctxWith({ binOverrideDir: '/opt/fake-bin' }))
    expect(env.PATH).toBe(['/opt/fake-bin', '/home/u/.local/bin', '/usr/bin'].join(delimiter))
  })

  it('also wins over a PATH the hub sent in the overrides', () => {
    process.env.PATH = '/usr/bin'
    const env = buildSpawnEnv(ctxWith({ binOverrideDir: '/opt/fake-bin' }), {
      PATH: ['/hub/bin', '/usr/bin'].join(delimiter)
    })
    expect(env.PATH).toBe(['/opt/fake-bin', '/hub/bin', '/usr/bin'].join(delimiter))
  })

  it('lists the dir once even when PATH already carries it', () => {
    process.env.PATH = ['/usr/bin', '/opt/fake-bin'].join(delimiter)
    const env = buildSpawnEnv(ctxWith({ binOverrideDir: '/opt/fake-bin' }))
    expect(env.PATH).toBe(['/opt/fake-bin', '/usr/bin'].join(delimiter))
  })

  it('never hands the override var itself to the spawned process', () => {
    process.env.SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR = '/opt/fake-bin'
    const env = buildSpawnEnv(ctxWith({ binOverrideDir: '/opt/fake-bin' }))
    expect(env).not.toHaveProperty('SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR')
  })
})
