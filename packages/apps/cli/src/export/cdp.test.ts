/**
 * Review 1, L3: a `slay` killed by SIGINT/SIGTERM mid-render must not leave its temp
 * browser profile (or the browser) behind. Node emits no 'exit' for a signal it has no
 * handler for, so an exit hook alone never ran. A real `slay`-like process launches a
 * fake CDP browser, is signalled, and the test checks what is left.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, test } from 'vitest'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-cdp-signal-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const REPO = path.resolve(__dirname, '../../../../..')
const CDP = path.resolve(__dirname, 'cdp.ts')

/** Answers every CDP command with `{}` over fds 3/4, records its pid, never exits. */
const FAKE_BROWSER = `#!/usr/bin/env node
const fs = require('fs')
fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid))
const out = fs.createWriteStream(null, { fd: 4 })
let buf = ''
fs.createReadStream(null, { fd: 3, encoding: 'utf8' }).on('data', (c) => {
  buf += c
  let end
  while ((end = buf.indexOf('\\0')) !== -1) {
    const msg = JSON.parse(buf.slice(0, end))
    buf = buf.slice(end + 1)
    out.write(JSON.stringify({ id: msg.id, result: {} }) + '\\0')
  }
})
setInterval(() => {}, 1000)
`

const DRIVER = `import { launchBrowser } from ${JSON.stringify(CDP)}
await launchBrowser(process.env.FAKE_BROWSER)
console.log('ready')
setInterval(() => {}, 1000)
`

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.skipIf(process.platform === 'win32').each(['SIGTERM', 'SIGINT'] as const)(
  '%s mid-render removes the temp profile, kills the browser and still ends the process',
  async (signal) => {
    const dir = fs.mkdtempSync(path.join(root, `${signal}-`))
    const tmp = path.join(dir, 'tmp')
    fs.mkdirSync(tmp)
    const fake = path.join(dir, 'fake-browser')
    fs.writeFileSync(fake, FAKE_BROWSER, { mode: 0o755 })
    const driver = path.join(dir, 'driver.mts')
    fs.writeFileSync(driver, DRIVER)
    const pidFile = path.join(dir, 'browser.pid')

    const child = spawn('node', ['--import', 'tsx', driver], {
      cwd: REPO,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        TMPDIR: tmp,
        FAKE_BROWSER: fake,
        FAKE_PID_FILE: pidFile
      },
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
    expect(fs.readdirSync(tmp).filter((n) => n.startsWith('slay-export-profile-'))).toHaveLength(1)
    const browserPid = Number(fs.readFileSync(pidFile, 'utf8'))

    const ended = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once('exit', (_code, sig) => resolve(sig))
    )
    child.kill(signal)
    // The signal still ends the process (re-raised after cleanup, not swallowed).
    expect(await ended).toBe(signal)

    expect(fs.readdirSync(tmp).filter((n) => n.startsWith('slay-export-profile-'))).toEqual([])
    await expect.poll(() => alive(browserPid), { timeout: 5_000 }).toBe(false)
  },
  30_000
)
