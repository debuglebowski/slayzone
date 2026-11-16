import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import assert from 'node:assert/strict'

// The proof child owns its budget; the vitest timeout covers that budget plus cc/esbuild
// setup. execFileSync blocks the loop, so a shorter outer timeout fails completed proofs.
const CHILD_BUDGET_MS = 25000
const SETUP_HEADROOM_MS = 15000
export const PUBLICATION_PROOF_TEST_TIMEOUT_MS = CHILD_BUDGET_MS + SETUP_HEADROOM_MS

export async function runPublicationProof(mode: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `publication-${mode}-`)))
  try {
    const require = createRequire(import.meta.url)
    const extension = join(root, process.platform === 'darwin' ? 'syncprobe.dylib' : 'syncprobe.so')
    const domain = new URL('../../../domains/chat-runtime/src/server/', import.meta.url)
    if (mode !== 'public-range')
      execFileSync('cc', [
        '-std=c11',
        ...(process.platform === 'darwin' ? ['-dynamiclib'] : ['-shared', '-fPIC']),
        '-O2',
        '-pthread',
        '-I',
        fileURLToPath(
          new URL('../../../../node_modules/better-sqlite3/deps/sqlite3', import.meta.url)
        ),
        fileURLToPath(new URL('storage-fence.syncprobe.c', domain)),
        '-o',
        extension
      ])
    symlinkSync(
      new URL('../../../../node_modules', import.meta.url),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const fixture = join(root, 'publication.cjs')
    await build({
      entryPoints: [
        fileURLToPath(new URL('./artifact-publication.native.fixture.ts', import.meta.url))
      ],
      outfile: fixture,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['better-sqlite3', 'node-pty', 'node-datachannel', 'bufferutil', 'utf-8-validate'],
      logLevel: 'silent',
      plugins: [
        {
          name: 'actual-publication-observer',
          setup(build) {
            build.onResolve({ filter: /\?raw$/ }, (args) => ({
              path: require.resolve(args.path.slice(0, -4), { paths: [args.resolveDir] }),
              namespace: 'raw'
            }))
            build.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
              contents: await readFile(args.path, 'utf8'),
              loader: 'text'
            }))
            build.onLoad({ filter: /computer-worker-entry\.ts$/ }, () => ({
              contents: `export function computerStorageWorkerEntry() { return ${JSON.stringify(fileURLToPath(new URL('../dist/bin.cjs', import.meta.url)))} }`,
              loader: 'ts'
            }))
            build.onLoad({ filter: /computer-online-runtime\.ts$/ }, async (args) => {
              // Observe the actual production factory's result. Its implementation is unchanged.
              const source = (await readFile(args.path, 'utf8')).replace(
                'export async function openComputerChatRuntime(',
                'async function actualOpenComputerChatRuntime('
              )
              return {
                contents:
                  source +
                  '\nexport async function openComputerChatRuntime(opts: OpenComputerChatRuntimeOptions) { const r = await actualOpenComputerChatRuntime(opts); Reflect.get(globalThis, "__fu2PublicationRuntimes")?.set(opts.hubScope, r); return r }\n',
                loader: 'ts'
              }
            })
          }
        }
      ]
    })
    const args = [
      '--require',
      fileURLToPath(new URL('artifact-publication-probe.fixture.cjs', domain)),
      '--require',
      fileURLToPath(new URL('computer-online-no-main-sqlite.fixture.cjs', domain)),
      fixture,
      root,
      extension,
      fileURLToPath(new URL('../dist/bin.cjs', import.meta.url)),
      mode
    ]
    if (mode === 'cache-negative') {
      const failed = spawnSync(process.execPath, args, {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: CHILD_BUDGET_MS
      })
      assert.equal(failed.status, 1)
      assert.match(failed.stderr, /completed Job.request must be retired/)
      process.stdout.write(
        'Isolated old-retention negative control: positive assertion failed as expected\n'
      )
      return
    }
    const output = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: CHILD_BUDGET_MS
    })
    process.stdout.write(
      `${mode === 'public-range' ? 'Portable bounded fallback' : 'POSIX staged publication'} ${mode} proof ${output.trim()}\n`
    )
    return JSON.parse(output) as Record<string, unknown>
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
