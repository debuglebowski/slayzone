/**
 * `@slayzone/terminal/pty-detection` is bundled into the standalone computer. Bundle
 * the entry the way the computer does (esbuild, node target) and fail on anything
 * from the hub/app tree: electron, React, node-pty, the DB, tRPC, xterm, or the
 * terminal runtime (pty-manager and friends).
 */
import { describe, expect, test } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../../../../..')
const COMPUTER = join(ROOT, 'packages/apps/computer')
const { build } = createRequire(join(COMPUTER, 'package.json'))(
  'esbuild'
) as typeof import('esbuild')

const FORBIDDEN =
  /node_modules\/(electron|react|react-dom|node-pty|@lydell\/node-pty|better-sqlite3|@trpc|@xterm|zustand|@tanstack)\/|packages\/domains\/terminal\/src\/(server\/runtime|client|electron)\//

describe('pty-detection entry', () => {
  test('bundles without the hub/app tree', async () => {
    const result = await build({
      absWorkingDir: COMPUTER,
      entryPoints: [join(HERE, 'pty-detection.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      write: false,
      metafile: true,
      logLevel: 'silent',
      outfile: 'pty-detection-guard.cjs'
    })
    const inputs = Object.keys(result.metafile.inputs).map((p) =>
      relative(ROOT, join(COMPUTER, p)).replaceAll('\\', '/')
    )
    expect(inputs.length).toBeGreaterThan(5)
    expect(inputs.filter((p) => FORBIDDEN.test(p))).toEqual([])
  })

  test('exports what the computer needs', async () => {
    const m = await import('@slayzone/terminal/pty-detection')
    expect(typeof m.getAdapter).toBe('function')
    expect(typeof m.RingBuffer).toBe('function')
    expect(typeof m.filterBufferData).toBe('function')
    expect(typeof m.computeSyncQueryResponse).toBe('function')
    expect(m.DEV_SERVER_URL_PATTERN).toBeInstanceOf(RegExp)
  })
})
