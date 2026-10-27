/**
 * The packaged app runs as production: NODE_ENV is forced to `production` before any
 * other main-process module loads, whatever the launching shell exported. Unpackaged
 * runs (dev, e2e) keep the launcher's value.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

const prevNodeEnv = process.env.NODE_ENV

afterEach(() => {
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = prevNodeEnv
  vi.resetModules()
})

async function nodeEnvAfterLoad(
  isPackaged: boolean,
  launcherValue: string | undefined
): Promise<string | undefined> {
  if (launcherValue === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = launcherValue
  const { app } = await import('electron')
  ;(app as { isPackaged: boolean }).isPackaged = isPackaged
  await import('./packaged-node-env')
  return process.env.NODE_ENV
}

describe('packaged NODE_ENV', () => {
  it('is production in the packaged app', async () => {
    expect(await nodeEnvAfterLoad(true, undefined)).toBe('production')
  })

  it('overrides a value inherited from the launching shell', async () => {
    expect(await nodeEnvAfterLoad(true, 'development')).toBe('production')
  })

  it('is left alone when unpackaged (dev, e2e)', async () => {
    expect(await nodeEnvAfterLoad(false, 'development')).toBe('development')
    vi.resetModules()
    expect(await nodeEnvAfterLoad(false, undefined)).toBeUndefined()
  })

  it('is applied by the first import of the main entry, before any other module loads', () => {
    const entry = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(entry.match(/^import .+$/m)?.[0]).toBe("import './packaged-node-env'")
  })
})
