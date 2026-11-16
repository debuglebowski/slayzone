/**
 * `onExitOrSignal`: a cleanup that throws inside a signal handler (seen: an `rmSync`
 * racing a write still in flight, ENOTEMPTY) must neither keep the other cleanups
 * from running nor turn "killed by SIGINT" into a crash with exit code 1.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, test } from 'vitest'

const REPO = path.resolve(__dirname, '../../../../..')
const TSX = pathToFileURL(path.join(REPO, 'node_modules/tsx/dist/esm/index.mjs')).href
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-signal-cleanup-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

test.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'] as const)(
  '%s: a throwing cleanup still lets the others run, and the process ends by the signal',
  async (signal) => {
    const dir = fs.mkdtempSync(path.join(root, `${signal}-`))
    const marker = path.join(dir, 'second-ran')
    const driver = path.join(dir, 'driver.mts')
    fs.writeFileSync(
      driver,
      `import fs from 'node:fs'
import { onExitOrSignal } from ${JSON.stringify(path.resolve(__dirname, 'signal-cleanup.ts'))}
onExitOrSignal(() => {
  throw new Error('ENOTEMPTY: directory not empty')
})
onExitOrSignal(() => fs.writeFileSync(${JSON.stringify(marker)}, 'ok'))
setInterval(() => undefined, 1 << 30)
console.log('ready')
`
    )
    const child = spawn('node', ['--import', TSX, driver], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d
    })
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d) => String(d).includes('ready') && resolve())
      child.once('exit', () => reject(new Error(`driver exited early: ${stderr}`)))
    })
    const ended = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((r) =>
      child.once('exit', (code, sig) => r({ code, sig }))
    )
    child.kill(signal)
    expect(await ended, stderr).toEqual({ code: null, sig: signal })
    expect(fs.existsSync(marker)).toBe(true)
    // The failed cleanup is reported, not swallowed.
    expect(stderr).toContain('ENOTEMPTY')
  },
  60_000
)
