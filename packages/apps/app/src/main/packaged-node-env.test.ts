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

  /**
   * A static import loads before the importing file runs, so a line in index.ts would
   * run only after every library index.ts imports from node_modules. The packaged
   * app's entry is bootstrap.ts instead: it sets NODE_ENV, then loads index.ts.
   */
  it('is applied by the packaged entry before any other main-process module loads', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(pkg.main).toBe('./out/main/bootstrap.js')

    const bootstrap = readFileSync(new URL('./bootstrap.ts', import.meta.url), 'utf8')
    expect(bootstrap.match(/^import .+$/gm)).toEqual(["import './packaged-node-env'"])
    expect(bootstrap).toMatch(/^await import\('\.\/index'\)$/m)
  })
})
