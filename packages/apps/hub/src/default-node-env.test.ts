/**
 * The hub runs as production unless its launcher says otherwise: NODE_ENV defaults to
 * `production` before any library loads (better-auth captures it at module load, tRPC
 * and Express read it when the hub builds them).
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const prevNodeEnv = process.env.NODE_ENV

afterEach(() => {
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = prevNodeEnv
  vi.resetModules()
})

async function nodeEnvAfterLoad(launcherValue: string | undefined): Promise<string | undefined> {
  if (launcherValue === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = launcherValue
  await import('./default-node-env.js')
  return process.env.NODE_ENV
}

describe('default NODE_ENV', () => {
  it('is production when the launcher sets none (standalone hub, npx)', async () => {
    expect(await nodeEnvAfterLoad(undefined)).toBe('production')
    vi.resetModules()
    expect(await nodeEnvAfterLoad('')).toBe('production')
  })

  it("keeps the launcher's value (dev app's sidecar, an operator's choice)", async () => {
    expect(await nodeEnvAfterLoad('development')).toBe('development')
  })

  it('is applied by the first import of the hub entry, before any library loads', () => {
    const entry = readFileSync(new URL('./bin.ts', import.meta.url), 'utf8')
    expect(entry.match(/^import .+$/m)?.[0]).toBe("import './default-node-env.js'")
  })
})
