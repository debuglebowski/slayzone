import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import { getComputerConfigFilePath } from '@slayzone/platform/slayzone-config'
import type { ComputerConfig } from '../config'
import { createFsHandlers } from './fs'
import { createComputerConfigHandlers } from './computer-config'
import type { ComputerDialer } from './types'

const dialer: ComputerDialer = { notify: () => true }

let dir: string
let home: string

// `updateComputerConfigFile` resolves its path from the computer ROOT, which derives
// from HOME. Point both at a tmpdir so the test never writes the real config.
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'computer-cfg-')))
  home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  process.env.HOME = home
  process.env.USERPROFILE = home
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ctxWith(roots: string[]) {
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: roots,
    capabilities: ['fs']
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
    const fs = createFsHandlers(ctx)
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
