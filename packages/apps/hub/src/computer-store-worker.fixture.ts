import { fileURLToPath } from 'node:url'
/** Build native test imports into an isolated worker, preserving production's data-only protocol. */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const requireComputer = createRequire(new URL('../../computer/package.json', import.meta.url))
export async function buildStoreFixture(kind: 'handoff' | 'soak') {
  const dir = mkdtempSync(join(tmpdir(), 'computer-store-fixture-'))
  const path = join(dir, 'worker.cjs')
  try {
    symlinkSync(
      fileURLToPath(new URL('../../../../node_modules', import.meta.url)),
      join(dir, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await (requireComputer('esbuild') as typeof import('esbuild')).build({
      entryPoints: [
        fileURLToPath(new URL('./computer-store-worker-entry.fixture.ts', import.meta.url))
      ],
      outfile: path,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      define: { __STORE_FIXTURE__: JSON.stringify(kind) },
      external: ['better-sqlite3', 'node-pty', 'node-datachannel'],
      logLevel: 'silent'
    })
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}
