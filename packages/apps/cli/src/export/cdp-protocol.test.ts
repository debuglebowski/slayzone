/**
 * Review 4, C1 / C3: the CLI's CDP client against a scriptable fake browser.
 *  - C1: a large PDF works — `printToPDF` has no fixed deadline (a liveness check
 *    instead), its bytes stream back over `IO.read`, and incoming frames are parsed
 *    in linear time whatever their size.
 *  - C3: a browser whose stdio outlives it (a wrapper script's grandchild holding the
 *    pipe) does not keep `slay` from finishing.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'
import { CdpFrameReader, browserArgs, launchBrowser, ownProcess, processFate } from './cdp'
import { renderPdf } from './render'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-cdp-proto-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/**
 * A fake browser speaking CDP over fds 3/4. `PRINT_DELAY_MS`: how long printToPDF takes;
 * `HANG_AFTER_PRINT`: stop answering anything once a print started (a wedged browser).
 * The PDF comes back as a stream of `PDF_CHUNKS` reads.
 * `ON_PRINT` makes the page die mid-print while the browser keeps answering:
 * `inspector-crash` (Inspector.targetCrashed on the page session), `target-crash`
 * (browser-level Target.targetCrashed), `detach` (Target.detachedFromTarget) or
 * `vanish` (no event; the target is simply gone from Target.getTargets).
 * `VERSION_DELAY_MS` delays every Browser.getVersion answer, `TARGETS_DELAY_MS` every
 * Target.getTargets answer (a page command's liveness check); `LOG_FILE` records each
 * method received, one per line.
 * `PAGE_SPINS_ON_PRINT`: once a print starts the page's own commands (Runtime.evaluate)
 * go unanswered and the print never finishes, while the browser keeps answering (a
 * script looping in the renderer). `EVAL_DELAY_MS` delays every Runtime.evaluate.
 * `FAKE_RENDERER`: the page runs in a real child process (its args carry the profile's
 * `--user-data-dir`, as Chrome's renderers do), reported by the one-shot trace's
 * `TracingStartedInBrowser`; `ON_PRINT=renderer-dies` kills it mid-print and the browser
 * says nothing (a renderer the OS holds while it dumps core: no exit, no crash event).
 * Like Chrome's zygote-forked renderers on Linux, it retitles itself: its command line
 * becomes one space-joined string (`/proc/<pid>/cmdline`), no longer NUL-separated. The
 * trace comes in several `Tracing.dataCollected` chunks and only a middle one names the
 * page's process, as Chrome's did on CI.
 */
const FAKE = `#!/usr/bin/env node
const fs = require('fs')
const out = fs.createWriteStream(null, { fd: 4 })
const delay = Number(process.env.PRINT_DELAY_MS || 0)
const hang = process.env.HANG_AFTER_PRINT === '1'
const chunks = Number(process.env.PDF_CHUNKS || 3)
const onPrint = process.env.ON_PRINT || ''
const versionDelay = Number(process.env.VERSION_DELAY_MS || 0)
const targetsDelay = Number(process.env.TARGETS_DELAY_MS || 0)
const log = process.env.LOG_FILE
const spinOnPrint = process.env.PAGE_SPINS_ON_PRINT === '1'
const evalDelay = Number(process.env.EVAL_DELAY_MS || 0)
const userDataDir = process.argv.find((a) => a.startsWith('--user-data-dir='))
const renderer = process.env.FAKE_RENDERER === '1'
  ? require('child_process').spawn(
      process.execPath,
      [
        '-e',
        // Chrome's title: the whole command line as one string. The script is padded so
        // the original argv has room for it (a title never grows past that).
        'process.title = ["/opt/google/chrome/chrome", "--type=renderer", process.argv[1], "--lang=en-US"].join(" "); setInterval(() => {}, 1000) // ' + 'x'.repeat(80),
        '--',
        userDataDir
      ],
      { stdio: 'ignore' }
    )
  : null
let spinning = false
let targetGone = false
let hung = false
let reads = 0
const reply = (id, result) => out.write(JSON.stringify({ id, result }) + '\\0')
const emit = (method, params, sessionId) => out.write(JSON.stringify({ method, params, sessionId }) + '\\0')
const pdfPiece = (i) => Buffer.from(i === 0 ? '%PDF-1.7 ' : 'x'.repeat(1000)).toString('base64')
let buf = ''
fs.createReadStream(null, { fd: 3, encoding: 'utf8' }).on('data', (c) => {
  buf += c
  let end
  while ((end = buf.indexOf('\\0')) !== -1) {
    const m = JSON.parse(buf.slice(0, end))
    buf = buf.slice(end + 1)
    if (log) fs.appendFileSync(log, m.method + '\\n')
    if (hung) continue
    switch (m.method) {
      case 'Browser.getVersion': setTimeout(() => reply(m.id, { product: 'Fake/1' }), versionDelay); break
      case 'Target.getTargets': {
        const targetInfos = targetGone ? [] : [{ targetId: 't1', type: 'page' }]
        setTimeout(() => reply(m.id, { targetInfos }), targetsDelay)
        break
      }
      case 'Target.createTarget': reply(m.id, { targetId: 't1' }); break
      case 'Target.attachToTarget': reply(m.id, { sessionId: 's1' }); break
      case 'Page.getFrameTree': reply(m.id, { frameTree: { frame: { id: 'f1' } } }); break
      case 'Tracing.end':
        reply(m.id, {})
        if (renderer) {
          const frames = [{ frame: 't1', processId: renderer.pid }]
          const other = [{ name: 'TracingStartedInBrowser', args: { data: { frames: [] } } }, { name: 'Other', args: {} }]
          emit('Tracing.dataCollected', { value: other }, m.sessionId)
          emit('Tracing.dataCollected', { value: [{ name: 'TracingStartedInBrowser', args: { data: { frames } } }] }, m.sessionId)
          emit('Tracing.dataCollected', { value: other }, m.sessionId)
        }
        emit('Tracing.tracingComplete', {}, m.sessionId)
        break
      case 'Runtime.evaluate':
        if (!spinning) setTimeout(() => reply(m.id, { result: { value: true } }), evalDelay)
        break
      case 'Page.printToPDF':
        if (hang) { hung = true; break }
        if (spinOnPrint) { spinning = true; break }
        if (onPrint === 'inspector-crash') { emit('Inspector.targetCrashed', {}, m.sessionId); break }
        if (onPrint === 'target-crash') { emit('Target.targetCrashed', { targetId: 't1', status: 'crashed', errorCode: 9 }); break }
        if (onPrint === 'detach') { emit('Target.detachedFromTarget', { sessionId: m.sessionId, targetId: 't1' }); break }
        if (onPrint === 'vanish') { targetGone = true; break }
        if (onPrint === 'renderer-dies') { renderer.kill('SIGKILL'); spinning = true; break }
        setTimeout(() => {
          if (m.params.transferMode === 'ReturnAsStream') reply(m.id, { stream: 'h1' })
          else reply(m.id, { data: Buffer.from('%PDF-inline').toString('base64') })
        }, delay)
        break
      case 'IO.read':
        reply(m.id, reads < chunks ? { data: pdfPiece(reads++), base64Encoded: true, eof: false } : { data: '', eof: true })
        break
      default: reply(m.id, {})
    }
  }
})
setInterval(() => {}, 1000)
`

function fake(name: string): string {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, FAKE, { mode: 0o755 })
  return p
}

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

describe.skipIf(process.platform === 'win32')('C1: large PDFs', () => {
  test('a print slower than the per-command deadline still completes', async () => {
    const exe = fake('slow')
    const pdf = await withEnv({ PRINT_DELAY_MS: '1500', PDF_CHUNKS: '4' }, () =>
      renderPdf(exe, '<p>x</p>', {
        waitReady: false,
        browser: { commandTimeoutMs: 300, livenessIntervalMs: 200, livenessTimeoutMs: 10_000 }
      })
    )
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.7')
    // Streamed: every IO.read chunk arrived, in order.
    expect(pdf.byteLength).toBe('%PDF-1.7 '.length + 3 * 1000)
  }, 30_000)

  test('a browser that stops answering mid-print is detected, not waited on forever', async () => {
    const exe = fake('wedged')
    const started = Date.now()
    await expect(
      withEnv({ HANG_AFTER_PRINT: '1' }, () =>
        renderPdf(exe, '<p>x</p>', {
          waitReady: false,
          browser: { commandTimeoutMs: 300, livenessIntervalMs: 200 }
        })
      )
    ).rejects.toThrow(/stopped responding/)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 30_000)

  test('frames are parsed in linear time: a 48 MB message in 64 KB pieces', () => {
    const got: string[] = []
    const reader = new CdpFrameReader((raw) => got.push(raw))
    const big = `{"id":1,"result":{"data":"${'A'.repeat(48 * 1024 * 1024)}"}}`
    const stream = `${big}\0{"id":2}\0{"id":3,"partial"`
    const started = Date.now()
    for (let i = 0; i < stream.length; i += 64 * 1024) reader.push(stream.slice(i, i + 64 * 1024))
    reader.push(':1}\0')
    const ms = Date.now() - started
    expect(got.map((m) => m.length)).toEqual([big.length, 8, 20])
    expect(got[2]).toBe('{"id":3,"partial":1}')
    // Quadratic re-scanning measured 8.4 s for 67 MB; linear is well under a second.
    expect(ms).toBeLessThan(3_000)
  })
})

describe.skipIf(process.platform === 'win32')('C3: a browser whose pipes outlive it', () => {
  test('close finishes although a grandchild still holds stdio', async () => {
    // A wrapper that starts the fake browser as a grandchild sharing its stdio, then
    // exits on SIGTERM/SIGKILL without taking the grandchild with it.
    const inner = fake('inner')
    const wrapper = path.join(tmp, 'wrapper')
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\n"${process.execPath}" "${inner}" "$@" &\nchild=$!\ntrap 'exit 0' TERM\nwait $child\n`,
      { mode: 0o755 }
    )
    const b = await withEnv({ ELECTRON_RUN_AS_NODE: '1' }, () =>
      launchBrowser(wrapper, { exitGraceMs: 300 })
    )
    const started = Date.now()
    await b.close()
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 30_000)
})

/** Review 5, #2: a page that crashes mid-print while the browser keeps answering. */
describe.skipIf(process.platform === 'win32')('#2: a page crash fails a long render', () => {
  for (const how of ['inspector-crash', 'target-crash', 'detach', 'vanish']) {
    test(`${how} → the print fails promptly with a clear error`, async () => {
      const exe = fake(`crash-${how}`)
      const started = Date.now()
      await expect(
        withEnv({ ON_PRINT: how }, () =>
          renderPdf(exe, '<p>x</p>', {
            waitReady: false,
            browser: { commandTimeoutMs: 300, livenessIntervalMs: 200, livenessTimeoutMs: 10_000 }
          })
        )
      ).rejects.toThrow(/page (crashed|closed) while rendering/)
      expect(Date.now() - started).toBeLessThan(10_000)
    }, 30_000)
  }
})

/**
 * CI round 2: on Linux a crashed renderer can stay alive while the kernel pipes its core
 * to the system's dump handler (systemd-coredump, apport: `fs.suid_dumpable=2`). The
 * browser sees nothing until the dump is done (forever, for a handler that never
 * finishes), so no crash event comes. The page's own process says it: watched directly.
 */
describe.skipIf(process.platform === 'win32')('a page whose renderer dies unannounced', () => {
  test('the print fails promptly although no event and no liveness check says so', async () => {
    const exe = fake('renderer-dies')
    const started = Date.now()
    await expect(
      withEnv({ FAKE_RENDERER: '1', ON_PRINT: 'renderer-dies' }, () =>
        renderPdf(exe, '<p>x</p>', {
          waitReady: false,
          // Far beyond the test: only the page's process can end the print.
          browser: {
            commandTimeoutMs: 5_000,
            livenessIntervalMs: 120_000,
            stallMs: 120_000,
            stallProbeIntervalMs: 100
          }
        })
      )
    ).rejects.toThrow(/page crashed while rendering/)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 30_000)
})

/**
 * CI round 3: Chrome's zygote-forked processes (renderers) retitle themselves on Linux —
 * `/proc/<pid>/cmdline` is then the whole command line as ONE space-joined string, the
 * rest of the old argv zero-filled. Matching NUL-separated args only, the page's own
 * renderer was taken for a stranger and never watched.
 */
describe('ownProcess (Linux: /proc/<pid>/cmdline)', () => {
  const dir = '/tmp/slay-export-profile-djMy2I'
  /** `ownProcess` of pid 42 on Linux, whose /proc/42/cmdline reads `text`. */
  const own = (text: string, profile = dir): boolean =>
    ownProcess(42, profile, 'linux', (p) => {
      if (p === '/proc/42/cmdline') return text
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    })
  const args = (...a: string[]): string => [...a, ''].join('\0')
  test('NUL-separated args (a process that kept its argv)', () => {
    expect(own(args('/opt/google/chrome/chrome', '--type=zygote', `--user-data-dir=${dir}`))).toBe(
      true
    )
  })
  test("one retitled string (a renderer, as on CI's runner)", () => {
    const title = `/opt/google/chrome/chrome --type=renderer --crashpad-handler-pid=15078 --user-data-dir=${dir} --lang=en-US --num-raster-threads=2`
    expect(own(`${title}\0\0\0\0`)).toBe(true)
    expect(own(`/opt/google/chrome/chrome --user-data-dir=${dir}`)).toBe(true)
  })
  test('another profile, or one whose path merely starts like ours, is not ours', () => {
    expect(own(args('chrome --type=renderer --user-data-dir=/tmp/slay-export-profile-x'))).toBe(
      false
    )
    expect(own(`chrome --type=renderer --user-data-dir=${dir}x --lang=en`)).toBe(false)
    expect(own(args('chrome', `--user-data-dir=${dir}/sub`))).toBe(false)
  })
  test('a profile path with spaces matches in either form', () => {
    const spaced = '/tmp/my dir/slay-export-profile-x'
    expect(own(`chrome --type=renderer --user-data-dir=${spaced} --lang=en`, spaced)).toBe(true)
    expect(own(args('chrome', `--user-data-dir=${spaced}`), spaced)).toBe(true)
  })
  test("an unreadable or vanished process is not ours; elsewhere pids are the system's", () => {
    expect(own('')).toBe(false)
    expect(
      ownProcess(7, dir, 'linux', () => fs.readFileSync('/nonexistent/7/cmdline', 'utf8'))
    ).toBe(false)
    expect(ownProcess(42, dir, 'darwin', () => '')).toBe(true)
  })
})

describe('processFate (Linux: /proc)', () => {
  const proc =
    (files: Record<string, string>) =>
    (p: string): string => {
      if (p in files) return files[p] as string
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    }
  const stat = (state: string) => `42 (chrome (x)) ${state} 1 42 42 0 -1`
  test('running, dumping core, a zombie, gone', () => {
    const running = proc({
      '/proc/42/stat': stat('S'),
      '/proc/42/status': 'Name:\tchrome\nCoreDumping:\t0\n'
    })
    expect(processFate(42, 'linux', running)).toBe('running')
    const dumping = proc({
      '/proc/42/stat': stat('D'),
      '/proc/42/status': 'Name:\tchrome\nCoreDumping:\t1\n'
    })
    expect(processFate(42, 'linux', dumping)).toBe('crashed')
    expect(processFate(42, 'linux', proc({ '/proc/42/stat': stat('Z') }))).toBe('gone')
    expect(processFate(42, 'linux', proc({}))).toBe('gone')
  })
  test('a /proc it cannot read is no verdict', () => {
    const denied = (): string => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    }
    expect(processFate(42, 'linux', denied)).toBe('running')
  })
})

/** Review 5, #7: a liveness probe answered after the long command settled. */
describe.skipIf(process.platform === 'win32')(
  '#7: the liveness watchdog stops with the command',
  () => {
    test('no probe is sent after the long command settles', async () => {
      const exe = fake('watchdog')
      const log = path.join(tmp, 'watchdog.log')
      // Timeline: probe sent at 200 ms, print answered at 250 ms (probe in flight),
      // probe answered at 300 ms. Nothing may poll after that.
      const b = await withEnv(
        { PRINT_DELAY_MS: '250', VERSION_DELAY_MS: '100', LOG_FILE: log },
        () => launchBrowser(exe, { livenessIntervalMs: 200, livenessTimeoutMs: 10_000 })
      )
      try {
        await b.sendLong('Page.printToPDF', {}, 's1')
        const probes = (): number =>
          fs
            .readFileSync(log, 'utf8')
            .split('\n')
            .filter((l) => l === 'Browser.getVersion').length
        // The in-flight probe (and the launch handshake) is answered by now.
        await new Promise((r) => setTimeout(r, 500))
        const settled = probes()
        expect(settled).toBeGreaterThanOrEqual(2)
        await new Promise((r) => setTimeout(r, 1_000))
        expect(probes()).toBe(settled)
      } finally {
        await b.close()
      }
    }, 30_000)
  }
)

/** Review 7, #3: a page whose script spins once printing starts. */
describe.skipIf(process.platform === 'win32')('#3: a page that stops answering mid-print', () => {
  test('the print fails once the page has not answered for stallMs', async () => {
    const exe = fake('spin')
    await expect(
      withEnv({ PAGE_SPINS_ON_PRINT: '1' }, () =>
        renderPdf(exe, '<p>x</p>', {
          waitReady: false,
          // The browser keeps answering its liveness check every 200 ms throughout.
          browser: {
            commandTimeoutMs: 300,
            livenessIntervalMs: 200,
            livenessTimeoutMs: 10_000,
            stallMs: 1_000,
            stallProbeIntervalMs: 100
          }
        })
      )
    ).rejects.toThrow(/page stopped responding/)
  }, 30_000)

  test('a page that answers slowly but within stallMs is not failed', async () => {
    const exe = fake('slow-page')
    const pdf = await withEnv({ PRINT_DELAY_MS: '2500', EVAL_DELAY_MS: '400' }, () =>
      renderPdf(exe, '<p>x</p>', {
        waitReady: false,
        browser: {
          commandTimeoutMs: 5_000,
          livenessIntervalMs: 200,
          livenessTimeoutMs: 10_000,
          stallMs: 1_500,
          stallProbeIntervalMs: 100
        }
      })
    )
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.7')
  }, 30_000)
})

// Review 9, F2: a page the renderer gives up on (it tried to navigate away) still gets
// the answers it is held on — a paused request left unanswered would go out when the
// session ends — and its browser can be ended at once instead of shut down.
describe.skipIf(process.platform === 'win32')('review 9: a page given up on', () => {
  test('failPage: its commands fail with the given error; answers to its pauses still go', async () => {
    const log = path.join(tmp, 'failpage.log')
    const b = await withEnv({ LOG_FILE: log }, () => launchBrowser(fake('failpage')))
    try {
      const { sessionId } = await b.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId: 't1',
        flatten: true
      })
      const err = new Error('refused')
      b.failPage(sessionId, err)
      await expect(b.send('Runtime.evaluate', { expression: '1' }, sessionId)).rejects.toBe(err)
      for (const method of [
        'Fetch.failRequest',
        'Fetch.continueRequest',
        'Fetch.fulfillRequest',
        'Page.handleJavaScriptDialog'
      ]) {
        await expect(b.send(method, { requestId: 'r1' }, sessionId)).resolves.toEqual({})
      }
      const sent = fs.readFileSync(log, 'utf8').split('\n')
      expect(sent).not.toContain('Runtime.evaluate')
      expect(sent).toContain('Fetch.failRequest')
      expect(sent).toContain('Page.handleJavaScriptDialog')
    } finally {
      await b.close()
    }
  }, 30_000)

  test('close({ kill: true }) ends the browser without asking it to shut down', async () => {
    const log = path.join(tmp, 'kill.log')
    const b = await withEnv({ LOG_FILE: log }, () => launchBrowser(fake('kill')))
    await b.close({ kill: true })
    expect(fs.readFileSync(log, 'utf8').split('\n')).not.toContain('Browser.close')
    // Ended: nothing more can be sent.
    await expect(b.send('Browser.getVersion')).rejects.toThrow()
  }, 30_000)

  // Review 9, F1: the CDP download denial lasts only while a client is attached; once
  // a shutting-down browser lets go of it, the profile's own setting decides — never
  // Chrome's default (the person's Downloads folder).
  describe('the profile saves downloads inside itself', () => {
    afterEach(() => vi.restoreAllMocks())
    async function prefsOf(opts: { downloadDir?: string }): Promise<{
      profile: string
      prefs: { download: Record<string, unknown>; savefile: Record<string, unknown> }
    }> {
      const made: string[] = []
      const mkdtemp = fs.mkdtempSync
      vi.spyOn(fs, 'mkdtempSync').mockImplementation(((prefix: string, ...rest: never[]) => {
        const dir = mkdtemp(prefix, ...rest) as string
        made.push(dir)
        return dir
      }) as typeof fs.mkdtempSync)
      const b = await launchBrowser(fake('prefs'), opts)
      try {
        const profile = made.find((d) => path.basename(d).startsWith('slay-export-profile-'))
        if (!profile) throw new Error('no profile made')
        const file = path.join(profile, 'Default', 'Preferences')
        return { profile, prefs: JSON.parse(fs.readFileSync(file, 'utf8')) }
      } finally {
        await b.close({ kill: true })
      }
    }

    test('by default: a directory inside the throwaway profile', async () => {
      const { profile, prefs } = await prefsOf({})
      const dir = path.join(profile, 'downloads')
      expect(prefs.download).toEqual({ default_directory: dir, prompt_for_download: false })
      expect(prefs.savefile).toEqual({ default_directory: dir })
      // Removed with the profile.
      expect(fs.existsSync(profile)).toBe(false)
    }, 30_000)

    test('or the one given', async () => {
      const { prefs } = await prefsOf({ downloadDir: '/somewhere/else' })
      expect(prefs.download.default_directory).toBe('/somewhere/else')
    }, 30_000)
  })
})

// Follow-up N5: the tests above check liveness every 200 ms; its answer had the same
// 200 ms to arrive, and on a loaded machine it sometimes didn't ("the browser stopped
// responding"). The answer's deadline is its own option now (default: the interval).
describe.skipIf(process.platform === 'win32')('N5: the liveness deadline is its own', () => {
  test('a liveness answer slower than the interval but within its deadline does not fail the print', async () => {
    const exe = fake('slow-liveness')
    const pdf = await withEnv({ PRINT_DELAY_MS: '1500', TARGETS_DELAY_MS: '400' }, () =>
      renderPdf(exe, '<p>x</p>', {
        waitReady: false,
        browser: { commandTimeoutMs: 5_000, livenessIntervalMs: 200, livenessTimeoutMs: 5_000 }
      })
    )
    expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.7')
  }, 30_000)

  test('one past its deadline still fails it', async () => {
    const exe = fake('late-liveness')
    await expect(
      withEnv({ PRINT_DELAY_MS: '10000', TARGETS_DELAY_MS: '2000' }, () =>
        renderPdf(exe, '<p>x</p>', {
          waitReady: false,
          browser: { commandTimeoutMs: 5_000, livenessIntervalMs: 200, livenessTimeoutMs: 500 }
        })
      )
    ).rejects.toThrow(/stopped responding/)
  }, 30_000)
})

// CI round 3: `--disable-crashpad-for-testing` made Chrome 157's network service crash
// on start on Linux ("Crashing due to FD ownership violation"), in a loop: nothing
// loaded over the network. A crashed page is caught by watching its process instead.
describe('browser flags', () => {
  test('crashpad stays on everywhere: disabling it kills the network service', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(browserArgs('/p', platform)).not.toContain('--disable-crashpad-for-testing')
    }
    // The page to open stays last.
    expect(browserArgs('/p', 'linux').at(-1)).toBe('about:blank')
  })
})
