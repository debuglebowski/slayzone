/**
 * Desktop's export window in a REAL Electron, outside Playwright (whose CDP connection
 * attaches to every page and answers JS dialogs itself, which would hide review 6, M2).
 * `artifact-export.ts` is bundled with esbuild and driven by a small Electron main
 * script; each case renders one document and reports what happened.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/app/src/main/artifact-export.electron.test.ts
 */
import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const ELECTRON_BIN = require('electron') as unknown as string
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-export-electron-'))
const bundle = path.join(tmp, 'artifact-export.cjs')
const driver = path.join(tmp, 'driver.cjs')

interface CaseResult {
  ok: boolean
  error?: string
  head?: string
  ms: number
}
interface RunResult {
  cases: Record<string, CaseResult>
  console: string[]
  windowsLeft: number
}

const DRIVER = `
const { app, BrowserWindow } = require('electron')
const m = require(${JSON.stringify(bundle)})
const cases = JSON.parse(process.env.SLZ_TEST_CASES)
const timings = JSON.parse(process.env.SLZ_TEST_TIMINGS)
const consoleLines = []
app.on('window-all-closed', () => {})
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (...args) => {
    const first = args[0]
    consoleLines.push(first && typeof first.message === 'string' ? first.message : String(args[2]))
  })
})
app.dock && app.dock.hide()
app.whenReady().then(async () => {
  const out = {}
  for (const [name, html, format] of cases) {
    const started = Date.now()
    try {
      const bytes = format === 'png' ? await m.renderToPng(html, false, timings) : await m.renderToPdf(html, false, timings)
      out[name] = { ok: true, head: bytes.subarray(0, 8).toString('latin1'), ms: Date.now() - started }
    } catch (err) {
      out[name] = { ok: false, error: String(err && err.message), ms: Date.now() - started }
    }
  }
  await new Promise((r) => setTimeout(r, 300))
  const windowsLeft = BrowserWindow.getAllWindows().length
  process.stdout.write('SLZ_RESULT ' + JSON.stringify({ cases: out, console: consoleLines, windowsLeft }) + '\\n')
  app.exit(0)
})
`

const SHORT = { loadWaitMs: 2_000, unresponsiveMs: 2_000, stallMs: 3_000, readyWaitMs: 5_000 }

let child: ChildProcess | null = null

/** Render each `[name, html, format]` in one Electron run. */
function run(cases: Array<[string, string, 'pdf' | 'png']>, budgetMs = 90_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SLZ_TEST_CASES: JSON.stringify(cases),
      SLZ_TEST_TIMINGS: JSON.stringify(SHORT)
    }
    delete env.ELECTRON_RUN_AS_NODE
    const p = spawn(ELECTRON_BIN, [driver, `--user-data-dir=${path.join(tmp, 'profile')}`], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child = p
    let out = ''
    let err = ''
    p.stdout?.on('data', (d) => {
      out += d
    })
    p.stderr?.on('data', (d) => {
      err += d
    })
    const timer = setTimeout(() => {
      p.kill('SIGKILL')
      reject(new Error(`Electron run exceeded ${budgetMs} ms (a render hung)\n${err.slice(-2000)}`))
    }, budgetMs)
    p.on('exit', () => {
      clearTimeout(timer)
      child = null
      const line = out.split('\n').find((l) => l.startsWith('SLZ_RESULT '))
      if (line) resolve(JSON.parse(line.slice('SLZ_RESULT '.length)) as RunResult)
      else reject(new Error(`no result\n${out.slice(-2000)}\n${err.slice(-2000)}`))
    })
  })
}

beforeAll(async () => {
  await build({
    entryPoints: [path.join(__dirname, 'artifact-export.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    outfile: bundle,
    logLevel: 'silent'
  })
  fs.writeFileSync(driver, DRIVER)
}, 60_000)

afterAll(() => {
  child?.kill('SIGKILL')
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('export window in a real Electron', () => {
  // Review 6, M2: a JS dialog is answered at once (alert ok, confirm false) and never
  // blocks the render.
  test('alert, confirm and prompt are answered and the document renders', async () => {
    const r = await run([
      [
        'dialogs',
        // Electron has no prompt(): it throws (as everywhere in the app, as on main).
        "<p>x</p><script>alert('a'); var c = confirm('b'); var p;" +
          "try { p = prompt('c', 'd') } catch (e) { p = 'threw' }" +
          "console.log('slz-dialogs ' + c + ' ' + p)</script>",
        'pdf'
      ]
    ])
    expect(r.cases.dialogs).toMatchObject({ ok: true })
    expect(r.cases.dialogs.head?.startsWith('%PDF-')).toBe(true)
    expect(r.console, JSON.stringify(r)).toContain('slz-dialogs false threw')
    expect(r.cases.dialogs.ms).toBeLessThan(15_000)
    expect(r.windowsLeft).toBe(0)
  }, 120_000)

  // Review 6, M1: a script that loops only once printing has begun — after the load and
  // the first probe — fails the export within the stall deadline instead of hanging.
  test('a loop that starts when printing starts fails the export, window gone', async () => {
    const r = await run([
      [
        'beforeprint',
        "<p>x</p><script>addEventListener('beforeprint', function () { for (;;) {} })</script>",
        'pdf'
      ],
      ['after', '<p>fine</p>', 'pdf']
    ])
    expect(r.cases.beforeprint.ok).toBe(false)
    expect(r.cases.beforeprint.error).toMatch(/stopped responding/)
    expect(r.cases.beforeprint.ms).toBeLessThan(30_000)
    // The next export is unaffected.
    expect(r.cases.after).toMatchObject({ ok: true })
    expect(r.windowsLeft).toBe(0)
  }, 120_000)

  test('a plain document still renders, PDF and PNG', async () => {
    const r = await run([
      ['pdf', '<h1>Hello</h1>', 'pdf'],
      [
        'png',
        '<!DOCTYPE html><html><body><div style="display:inline-block"><svg width="40" height="20"></svg></div></body></html>',
        'png'
      ]
    ])
    expect(r.cases.pdf).toMatchObject({ ok: true })
    expect(r.cases.pdf.head?.startsWith('%PDF-')).toBe(true)
    expect(r.cases.png.ok).toBe(true)
    expect(r.cases.png.head?.slice(1, 4)).toBe('PNG')
  }, 120_000)
})
