import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubToRunnerMethods } from '@slayzone/computer-transport/shared'
import { getRunnerConfigFilePath } from '@slayzone/platform/slayzone-config'
import type { RunnerConfig } from '../config'
import { createFsHandlers } from './fs'
import { createRunnerConfigHandlers } from './runner-config'
import type { RunnerDialer } from './types'

const dialer: RunnerDialer = { notify: () => true }

let dir: string
let home: string

// `updateRunnerConfigFile` resolves its path from the runner ROOT, which derives
// from HOME. Point both at a tmpdir so the test never writes the real config.
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'runner-cfg-')))
  home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  process.env.HOME = home
  process.env.USERPROFILE = home
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ctxWith(roots: string[]) {
  const config: RunnerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: roots,
    capabilities: ['fs']
  }
  return { dialer, config, log: () => {} }
}

describe('runner.setAllowedRoots', () => {
  it('canonicalizes, de-duplicates, and persists the new jail', async () => {
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })

    const ctx = ctxWith([a])
    const handlers = createRunnerConfigHandlers(ctx)
    const res = (await handlers[HubToRunnerMethods.runnerSetAllowedRoots]({
      roots: [a, b, b]
    })) as { roots: string[]; rejected: unknown[] }

    expect(res.roots).toEqual([a, b])
    expect(res.rejected).toEqual([])

    const onDisk = JSON.parse(readFileSync(getRunnerConfigFilePath(), 'utf-8')) as {
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
    const cfg = createRunnerConfigHandlers(ctx)

    expect(() => fs[HubToRunnerMethods.fsPathExists]({ path: outside })).toThrow(/allowedRoots/)

    await cfg[HubToRunnerMethods.runnerSetAllowedRoots]({ roots: [inside, outside] })

    expect(fs[HubToRunnerMethods.fsPathExists]({ path: outside })).toEqual({ exists: true })
    // …and the browse surface reports the widened set, so the picker offers it.
    expect((fs[HubToRunnerMethods.fsListRoots]({}) as { roots: string[] }).roots).toEqual([
      inside,
      outside
    ])
  })

  it('rejects a relative root and one that does not exist, naming both', async () => {
    const real = join(dir, 'real')
    mkdirSync(real, { recursive: true })
    const handlers = createRunnerConfigHandlers(ctxWith([real]))

    const res = (await handlers[HubToRunnerMethods.runnerSetAllowedRoots]({
      roots: [real, 'relative/path', join(dir, 'ghost')]
    })) as { roots: string[]; rejected: { path: string; reason: string }[] }

    expect(res.roots).toEqual([real])
    expect(res.rejected.map((r) => r.reason)).toEqual([
      'not an absolute path',
      'does not exist on this runner'
    ])
  })

  // `coerceRunnerConfig` reads `allowedRoots: []` back as "unset" and falls
  // through to the defaults, so saving an empty set would apply now and silently
  // revert on restart. Refusing is the honest outcome.
  it('refuses an empty result rather than persisting a set that would revert', async () => {
    const real = join(dir, 'real')
    mkdirSync(real, { recursive: true })
    const ctx = ctxWith([real])
    const handlers = createRunnerConfigHandlers(ctx)

    // Synchronous throw — the dispatch table awaits handler results, so this
    // still reaches the hub as a rejected request.
    expect(() => handlers[HubToRunnerMethods.runnerSetAllowedRoots]({ roots: [] })).toThrow(
      /at least one allowed root/
    )
    expect(() =>
      handlers[HubToRunnerMethods.runnerSetAllowedRoots]({ roots: [join(dir, 'ghost')] })
    ).toThrow(/no usable roots/)

    // The live jail is untouched by a refused edit.
    expect(ctx.config.allowedRoots).toEqual([real])
  })
})
