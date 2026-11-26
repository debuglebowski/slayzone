/**
 * Real renders through a locally installed Chrome-family browser, over the same path
 * `slay tasks artifacts download --type pdf|png` takes (shared document → CDP over a
 * pipe). Skipped when this machine has no browser to find; never downloads one.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { defaultBrowserEnv, findBrowser } from './browser'
import { buildDocumentHtml } from '@slayzone/task-artifacts/export-html'
import { type Browser, type DebugHook, launchBrowser, openPage } from './cdp'
import { defaultExportDeps, exportArtifact, type ExportDeps } from './export-artifact'
import { renderPdf, renderPng } from './render'

const BROWSER = findBrowser(defaultBrowserEnv())
if (!BROWSER) console.error('SKIP render.integration: no Chrome/Chromium/Edge/Brave found')

const deps: ExportDeps = {
  ...defaultExportDeps(),
  installBrowser: async () => {
    throw new Error('the integration test never downloads a browser')
  }
}

/**
 * CI diagnostics for the tests that have failed only on GitHub's Linux runners: what
 * the export's debug hook reports (launch, every CDP event, Chrome's stderr, the
 * request guard's and the process watch's decisions), kept bounded and printed — each
 * line prefixed `[export-diag]` — only when the test fails. A passing test prints
 * nothing.
 *
 * Only the noisy lines are bounded (Chrome's stderr and raw CDP events: the first
 * `DIAG_HEAD` and the last `DIAG_TAIL`). The client's own decisions (`watch-*`,
 * `process-fate`, `guard-*`, `load-wait`, `page-*`, `exit`, …) and the facts gathered at
 * failure are never dropped. Pure noise is not kept at all: D-Bus complaints on stderr,
 * `Tracing.dataCollected` chunks and trace chunks that name no frame.
 */
const DIAG = '[export-diag]'
const DIAG_HEAD = 100
const DIAG_TAIL = 300
const DIAG_LINE = 1200
const DIAG_TOTAL = 400_000

/** JSON with stack traces dropped and long strings cut (`html` kept longer). */
function compact(value: unknown): string {
  return JSON.stringify(value ?? null, (key, v) => {
    if (key === 'initiator' && v && typeof v === 'object') return (v as { type?: unknown }).type
    if (key === 'stackTrace' || key === 'stack') return undefined
    if (typeof v === 'string') {
      const max = key === 'html' ? 4000 : 400
      return v.length > max ? `${v.slice(0, max)}…(${v.length})` : v
    }
    return v
  })
}

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5_000 }).trim()
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string }
    return `(failed: ${(e.stderr || e.stdout || e.message).trim().slice(0, 300)})`
  }
}

function readOr(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch (err) {
    return `(${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`
  }
}

/** The OS's say on core dumps and sandboxing (Linux; elsewhere what applies). */
function systemFacts(): string[] {
  const facts = [
    `platform ${process.platform} ${os.release()} uid=${process.getuid?.()} node=${process.version} electron=${process.versions.electron ?? '-'}`,
    `ulimit -c: ${run('sh', ['-c', 'ulimit -c'])}`
  ]
  if (process.platform === 'linux') {
    for (const f of [
      '/proc/sys/kernel/core_pattern',
      '/proc/sys/kernel/core_pipe_limit',
      '/proc/sys/fs/suid_dumpable',
      '/proc/sys/kernel/yama/ptrace_scope',
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
      '/proc/sys/kernel/unprivileged_userns_clone',
      '/proc/sys/user/max_user_namespaces'
    ]) {
      facts.push(`${f}: ${readOr(f)}`)
    }
    facts.push(
      `coredumpctl: ${run('coredumpctl', ['--no-pager', '--no-legend', 'list', '--since=-10min']).slice(0, 2000)}`
    )
  }
  return facts
}

/** What /proc says about `pid` (Linux): state, core dump, PID namespaces. */
function procFacts(pid: number): string {
  if (process.platform !== 'linux')
    return `pid ${pid}: ${run('ps', ['-o', 'pid,stat,etime', '-p', String(pid)])}`
  const status = readOr(`/proc/${pid}/status`)
  const pick = (k: string) => status.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1] ?? '?'
  return `pid ${pid}: exists=${fs.existsSync(`/proc/${pid}`)} State=${pick('State')} CoreDumping=${pick('CoreDumping')} PPid=${pick('PPid')} NSpid=${pick('NSpid')} TracerPid=${pick('TracerPid')}`
}

/** This browser's processes (`--user-data-dir`), as `ps` lists them. */
function browserProcesses(userDataDir: string | undefined): string[] {
  const all = run('ps', ['-ww', '-eo', 'pid,ppid,stat,etime,args']).split('\n')
  const ours = userDataDir ? all.filter((l) => l.includes(userDataDir)) : []
  return [
    `ps: ${ours.length} process(es) with ${userDataDir ?? '(no user-data-dir known)'}`,
    ...ours
      .slice(0, 40)
      .map((l) => `ps| ${l.replace(/\s--(?!type=|utility-sub-type=)[^\s]+/g, '').slice(0, 300)}`)
  ]
}

interface Diagnostics {
  debug: DebugHook
  add(line: string): void
  /** The page's pid the trace named, if any, and whether the export watches it. */
  tracedPid(): { pid: number; watched: boolean } | undefined
  userDataDir(): string | undefined
  /** Run `fn`; on failure print everything gathered (and `more()`), then fail as it did. */
  report(fn: () => Promise<void>, more?: () => Promise<string[]>): Promise<void>
}

function diagnostics(test: string): Diagnostics {
  const started = Date.now()
  /** Every line, in order; `noisy` ones are the only ones the bound may drop. */
  const lines: Array<{ text: string; noisy: boolean }> = []
  let previous = ''
  let previousNoisy = false
  let repeats = 0
  let dataDir: string | undefined
  let traced: { pid: number; watched: boolean } | undefined
  const flushRepeats = (): void => {
    if (repeats > 0) lines.push({ text: `  (previous line ×${repeats + 1})`, noisy: previousNoisy })
    repeats = 0
  }
  const addLine = (line: string, noisy: boolean): void => {
    const body = line.length > DIAG_LINE ? `${line.slice(0, DIAG_LINE)}…` : line
    if (body === previous) {
      repeats++
      return
    }
    flushRepeats()
    previous = body
    previousNoisy = noisy
    lines.push({ text: `+${Date.now() - started}ms ${body}`, noisy })
  }
  const add = (line: string): void => addLine(line, false)
  /** The lines to print: every first-class one, the noisy ones cut to head + tail. */
  const render = (head: number, tail: number): string[] => {
    const noisy = lines.filter((l) => l.noisy).length
    const out: string[] = []
    let seen = 0
    let dropped = 0
    for (const l of lines) {
      if (l.noisy) {
        const keep = seen < head || seen >= noisy - tail
        seen++
        if (!keep) {
          dropped++
          continue
        }
      }
      if (dropped) out.push(`… ${dropped} noisy line(s) dropped …`)
      dropped = 0
      out.push(l.text)
    }
    if (dropped) out.push(`… ${dropped} noisy line(s) dropped …`)
    return out
  }
  const debug: DebugHook = (what, detail) => {
    if (what === 'stderr') {
      for (const l of String(detail?.text ?? '').split('\n')) {
        if (l.trim() && !l.includes('dbus/')) addLine(`stderr| ${l}`, true)
      }
      return
    }
    if (what === 'launch') dataDir = String(detail?.userDataDir)
    if (what === 'watch-process' && typeof detail?.pid === 'number') {
      traced = { pid: detail.pid, watched: detail.watched === true }
    }
    if (what === 'event' && detail?.method === 'Tracing.dataCollected') return
    if (what === 'trace-frames' && Array.isArray(detail?.frames) && detail.frames.length === 0) {
      return
    }
    addLine(`${what} ${compact(detail)}`, what === 'event')
    // The load wait is over, the browser still runs: which processes it has now.
    if (what === 'page-state') for (const l of browserProcesses(dataDir)) add(l)
  }
  return {
    debug,
    add,
    tracedPid: () => traced,
    userDataDir: () => dataDir,
    async report(fn, more) {
      try {
        await fn()
      } catch (err) {
        const extra = await (more?.() ?? Promise.resolve([])).catch((e: Error) => [
          `(gathering failed: ${e.message})`
        ])
        for (const l of [...systemFacts(), ...extra]) add(l)
        flushRepeats()
        const text = (head: number, tail: number): string =>
          [
            `===== ${test}: FAILED (${(err as Error).message.slice(0, 300)})`,
            ...render(head, tail),
            `===== ${test}: end`
          ]
            .map((l) => `${DIAG} ${l}`)
            .join('\n')
        // Over the total: fewer noisy lines first; only then is the middle cut.
        let head = DIAG_HEAD
        let tail = DIAG_TAIL
        let out = text(head, tail)
        while (out.length > DIAG_TOTAL && head + tail > 0) {
          head = Math.floor(head / 2)
          tail = Math.floor(tail / 2)
          out = text(head, tail)
        }
        if (out.length > DIAG_TOTAL) {
          out = `${out.slice(0, DIAG_TOTAL / 3)}\n${DIAG} …(cut)…\n${out.slice(-(DIAG_TOTAL * 2) / 3)}`
        }
        console.error(out)
        throw err
      }
    }
  }
}

function pngSize(buf: Buffer): { w: number; h: number } {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

describe.skipIf(!BROWSER)('render in a local browser', () => {
  // Review 4, C1: a large document prints although printing takes far longer than
  // the per-command deadline, and its PDF streams back in pieces.
  // The deadline is cut to 3 s, not lower: it also bounds every ordinary command before
  // the print (loading the 15,000 lines, `document.fonts.ready`), which a loaded runner
  // stretches past 1 s. What proves the point is the print phase alone outlasting it
  // (~4 s on an idle M-series Mac), timed from the moment the long command starts.
  test('a 15,000-line code artifact → PDF (no fixed print deadline)', {
    timeout: 180_000
  }, async () => {
    const commandTimeoutMs = 3_000
    const code = Array.from(
      { length: 15_000 },
      (_, i) => `const line${i} = ${i} // ${'x'.repeat(40)}`
    ).join('\n')
    let printStarted: number | undefined
    const pdf = await renderPdf(BROWSER as string, buildDocumentHtml(code, 'code', 'big.ts'), {
      waitReady: false,
      browser: {
        commandTimeoutMs,
        // The long command's page watch starts with it: the print's start.
        debug: (what, detail) => {
          if (what === 'watch-page' && detail?.method === 'Page.printToPDF') {
            printStarted ??= Date.now()
          }
        }
      }
    })
    expect(printStarted).toBeDefined()
    // Printing (and streaming the PDF back) took longer than any one ordinary command
    // may: a fixed deadline on it would have failed the export.
    expect(Date.now() - (printStarted as number)).toBeGreaterThan(commandTimeoutMs)
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    // Hundreds of A4 pages.
    expect((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length).toBeGreaterThan(200)
  })

  test('markdown → PDF', { timeout: 60_000 }, async () => {
    const pdf = await exportArtifact(
      {
        type: 'pdf',
        content: '# Report\n\nSome **bold** text.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
        mode: 'markdown',
        title: 'report.md'
      },
      deps
    )
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(1000)
    // A4 portrait in points (595.28 × 841.89).
    expect(pdf.toString('latin1')).toMatch(/MediaBox\s*\[\s*0 0 595\.\d+ 841\.\d+\s*\]/)
  })

  test('svg → PNG at 2x the drawing size', { timeout: 60_000 }, async () => {
    const png = await exportArtifact(
      {
        type: 'png',
        content:
          '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#e11"/></svg>',
        mode: 'svg-preview',
        title: 'box.svg'
      },
      deps
    )
    const { w, h } = pngSize(png)
    // Exactly the drawing at 2x: the PNG document lays the <svg> out as a block, so
    // no inline baseline gap pads the capture.
    expect(w).toBe(240)
    expect(h).toBe(160)
  })

  test('mermaid → PNG (waits for mermaid to draw)', { timeout: 90_000 }, async () => {
    const warnings: string[] = []
    const png = await exportArtifact(
      {
        type: 'png',
        content: 'graph TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]\n  B -->|no| A\n',
        mode: 'mermaid-preview',
        title: 'flow.mmd'
      },
      { ...deps, log: (l) => warnings.push(l) }
    )
    expect(warnings).toEqual([])
    const { w, h } = pngSize(png)
    // A drawn flowchart, not the 10×10 floor nor the 400×300 "nothing there" default.
    expect(w % 2).toBe(0)
    expect(h % 2).toBe(0)
    expect(w).toBeGreaterThan(100)
    expect(h).toBeGreaterThan(300)
    expect(w).toBeLessThan(4000)
  })

  test('mermaid → PDF', { timeout: 90_000 }, async () => {
    const pdf = await exportArtifact(
      { type: 'pdf', content: 'graph LR\n  A --> B\n', mode: 'mermaid-preview', title: 'f.mmd' },
      deps
    )
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  })
})

describe.skipIf(!BROWSER)('a page that crashes mid-render (review 5, #2)', () => {
  let b: Browser | null = null
  // A test that times out never reaches its own cleanup: the browser goes here, always.
  afterEach(async () => {
    await b?.close({ kill: true })
    b = null
  })

  // The renderer dies while a long command runs; the browser process keeps answering
  // its liveness check. The command must fail at once, not wait forever — also where the
  // OS holds the crashed renderer while the system's dump handler takes its core and the
  // browser hears nothing (GitHub's Ubuntu runners: systemd-coredump), the page's own
  // process says it.
  test('a long command on a crashed page rejects within seconds', { timeout: 60_000 }, async () => {
    const diag = diagnostics('crash test')
    // What the browser and the OS say about the page's process when the crash goes unseen.
    const more = async (): Promise<string[]> => {
      const lines: string[] = []
      const traced = diag.tracedPid()
      lines.push(
        traced === undefined
          ? 'traced pid: none'
          : `traced (${traced.watched ? 'watched' : 'NOT watched'}) ${procFacts(traced.pid)}`
      )
      const ps = browserProcesses(diag.userDataDir())
      lines.push(...ps)
      for (const m of ps.join('\n').matchAll(/^ps\|\s*(\d+)\s.*--type=renderer/gm)) {
        lines.push(`renderer ${procFacts(Number(m[1]))}`)
      }
      for (const [method, params] of [
        ['Browser.getVersion', {}],
        ['Target.getTargets', {}],
        ['SystemInfo.getProcessInfo', {}]
      ] as const) {
        const answer = await Promise.race([
          b?.send(method, params).then(compact, (e: Error) => `error ${e.message}`),
          new Promise<string>((r) => setTimeout(() => r('no answer in 3 s'), 3_000))
        ])
        lines.push(`${method}: ${answer}`)
      }
      return lines
    }
    await diag.report(async () => {
      // A liveness interval far beyond the test: only the crash itself can end it.
      b = await launchBrowser(BROWSER as string, {
        livenessIntervalMs: 120_000,
        debug: diag.debug
      })
      await crashedPageRejects(b)
    }, more)
  })

  async function crashedPageRejects(browser: Browser): Promise<void> {
    // The page as an export opens it.
    const { sessionId } = await openPage(browser)
    const long = browser.sendLong(
      'Runtime.evaluate',
      { expression: 'new Promise(() => {})', awaitPromise: true },
      sessionId
    )
    const outcome = long.then(
      () => 'resolved',
      (err: Error) => err.message
    )
    const started = Date.now()
    // Page.crash itself is never answered: the renderer is gone.
    browser.send('Page.crash', {}, sessionId).catch(() => undefined)
    // Bounded well inside the test's timeout: a miss fails here, as an assertion.
    let bound: NodeJS.Timeout | undefined
    const missed = new Promise<string>((resolve) => {
      bound = setTimeout(() => resolve('still pending after 20 s'), 20_000)
    })
    expect(await Promise.race([outcome, missed])).toMatch(/page (crashed|closed) while rendering/)
    clearTimeout(bound)
    expect(Date.now() - started).toBeLessThan(10_000)
  }
})

describe.skipIf(!BROWSER)('an html artifact that opens JS dialogs (review 6, #2)', () => {
  // alert/confirm/prompt block the page until answered: unanswered, the document
  // never finishes loading and the export waits out the command deadline.
  test('alert/confirm/prompt are dismissed and the PDF is produced', {
    timeout: 60_000
  }, async () => {
    const html =
      "<!DOCTYPE html><script>alert('hi');document.title=String(confirm('x'))+'|'+String(prompt('y'))</script><p>done</p>"
    const pdf = await renderPdf(BROWSER as string, html, {
      waitReady: false,
      // A dialog left open blocks the page until this deadline fails the render (no
      // wall-clock bound asserted: render time on a loaded box varies too much).
      browser: { commandTimeoutMs: 15_000 }
    })
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  })

  test('a dialog opened after load (timer) does not stall the PNG', {
    timeout: 60_000
  }, async () => {
    const html =
      "<!DOCTYPE html><body style='margin:0'><div style='width:50px;height:40px;background:red'></div><script>setTimeout(() => alert('late'), 0)</script></body>"
    const png = await renderPng(BROWSER as string, html, {
      waitReady: false,
      browser: { commandTimeoutMs: 15_000 }
    })
    expect(pngSize(png).w).toBeGreaterThan(0)
  })
})

describe.skipIf(!BROWSER)('a script that loops once printing starts (review 7, #3)', () => {
  // The page's renderer spins while the browser process keeps answering: only a probe
  // of the page itself can tell. Unanswered for `stallMs`, the export fails (and the
  // browser goes with it) instead of waiting forever.
  // (A loop armed for later — `setTimeout` from beforeprint — is not a hang: the print
  // is laid out synchronously right after the event, before any timer runs.)
  test('a beforeprint handler that never yields fails the PDF with a clear error', {
    timeout: 120_000
  }, async () => {
    const html =
      "<!DOCTYPE html><p>x</p><script>addEventListener('beforeprint', () => { for (;;) {} })</script>"
    await expect(
      renderPdf(BROWSER as string, html, {
        waitReady: false,
        browser: { commandTimeoutMs: 30_000, stallMs: 3_000 }
      })
    ).rejects.toThrow(/page stopped responding/)
  })
})

/**
 * A local http server that records every request, so a test can assert the export
 * reached it — or that it never did. `/slow.png` answers after `SLOW_MS` (keeps the
 * document loading meanwhile); `/frame` is a page for a child frame, `/slow-frame` one
 * served after 2 s (logged as `served /slow-frame` once sent).
 */
function localServer(): {
  origin: () => string
  hits: string[]
  /** Diagnostics: every connection and request (method, headers), timestamped. */
  log: string[]
  start: () => Promise<void>
  stop: () => Promise<void>
} {
  const hits: string[] = []
  const log: string[] = []
  const stamp = (line: string): void => {
    log.push(`server ${new Date().toISOString()} ${line}`)
  }
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  )
  const server = http.createServer((req, res) => {
    stamp(`${req.method} ${req.url} ${compact(req.headers)}`)
    hits.push(req.url ?? '')
    if (req.url?.startsWith('/slow-frame')) {
      setTimeout(() => {
        hits.push(`served ${req.url}`)
        res.writeHead(200, { 'content-type': 'text/html' }).end('<p>slow frame</p>')
      }, 2_000)
      return
    }
    if (req.url?.startsWith('/slow.png')) {
      setTimeout(() => res.writeHead(200, { 'content-type': 'image/png' }).end(png), 2_000)
      return
    }
    if (req.url?.startsWith('/file')) {
      res
        .writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="slay-f1-attachment.txt"'
        })
        .end('pwned')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<p>remote page</p>')
  })
  server.on('connection', (socket) => {
    stamp(`connection from ${socket.remoteAddress}:${socket.remotePort}`)
  })
  return {
    hits,
    log,
    origin: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    start: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r())),
    stop: () => new Promise((r) => server.close(() => r()))
  }
}

/**
 * Diagnostics, run only once a child-frame test has failed: does a child frame's
 * request reach `server` from a browser launched as the export launches it, and from
 * one launched with a flag changed? The browser is started through a wrapper script
 * (as `--browser` allows), so the export code is unchanged. Each variant: one page,
 * one iframe, at most `PROBE_WAIT_MS` for its request.
 */
const PROBE_WAIT_MS = 6_000
const PROBE_VARIANTS: Array<{ label: string; drop?: string; add?: string }> = [
  { label: 'as the export launches it (control)' },
  // Round 3's cause, kept as a reference point: this one should say NOT requested.
  { label: 'with --disable-crashpad-for-testing', add: '--disable-crashpad-for-testing' },
  {
    label: 'with Local/Private Network Access checks off',
    add: '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessForNavigations,PrivateNetworkAccessRespectPreflightResults'
  },
  { label: 'with --no-sandbox', add: '--no-sandbox' }
]

async function frameProbes(server: ReturnType<typeof localServer>): Promise<string[]> {
  const lines: string[] = []
  const quote = (v: string): string => `'${v.replace(/'/g, "'\\''")}'`
  for (const [i, variant] of PROBE_VARIANTS.entries()) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-export-probe-'))
    const script = path.join(dir, 'browser.sh')
    fs.writeFileSync(
      script,
      [
        '#!/bin/sh',
        `for a in "$@"; do shift; [ "$a" = ${quote(variant.drop ?? '')} ] || set -- "$@" "$a"; done`,
        `exec ${quote(BROWSER as string)} "$@"${variant.add ? ` ${quote(variant.add)}` : ''}`
      ].join('\n'),
      { mode: 0o755 }
    )
    const probePath = `/probe-${i}`
    const started = Date.now()
    let outcome = 'NOT requested'
    let probe: Browser | undefined
    try {
      probe = await launchBrowser(script, { commandTimeoutMs: 10_000 })
      const { sessionId } = await openPage(probe)
      await probe.send('Page.enable', {}, sessionId)
      const { frameTree } = await probe.send<{ frameTree: { frame: { id: string } } }>(
        'Page.getFrameTree',
        {},
        sessionId
      )
      await probe.send(
        'Page.setDocumentContent',
        {
          frameId: frameTree.frame.id,
          html: `<!DOCTYPE html><p>probe</p><iframe src="${server.origin()}${probePath}"></iframe>`
        },
        sessionId
      )
      while (Date.now() - started < PROBE_WAIT_MS) {
        if (server.hits.includes(probePath)) {
          outcome = 'requested'
          break
        }
        await new Promise((r) => setTimeout(r, 100))
      }
    } catch (err) {
      outcome = `probe failed: ${(err as Error).message.slice(0, 300)}`
    } finally {
      await probe?.close({ kill: true }).catch(() => undefined)
      fs.rmSync(dir, { recursive: true, force: true })
    }
    lines.push(`frame probe ${variant.label}: ${outcome} (${Date.now() - started} ms)`)
  }
  return lines
}

/**
 * Review 9, F1: an html artifact (agent-written, untrusted) must not save files on the
 * machine running the export. The throwaway profile's download directory is pointed at
 * a temp dir the test watches (`downloadDir`; the export's own default is a dir inside
 * the profile, Chrome's is ~/Downloads), so whatever the browser saves lands in view.
 */
describe.skipIf(!BROWSER)('an html artifact cannot save files (review 9, F1)', () => {
  const server = localServer()
  let downloads: string
  beforeAll(() => server.start())
  afterAll(() => server.stop())
  // Removed even when a test fails: whatever an unblocked download left there.
  afterEach(() => fs.rmSync(downloads, { recursive: true, force: true }))

  /** A fresh temp dir the next export's profile downloads into. */
  function seedDownloadDir(): void {
    downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-f1-downloads-'))
  }

  /** Nothing in the seeded dir, and none of the test's file names in ~/Downloads. */
  function expectNothingSaved(): void {
    expect(fs.readdirSync(downloads)).toEqual([])
    const home = path.join(os.homedir(), 'Downloads')
    const there = fs.existsSync(home) ? fs.readdirSync(home) : []
    expect(there.filter((f) => f.startsWith('slay-f1-'))).toEqual([])
  }

  // Not a navigation: the download is denied and the export goes on, as on desktop
  // (its export session cancels every download).
  test('an <a download> click (blob: and data:) saves nothing; the PDF is produced', {
    timeout: 90_000
  }, async () => {
    seedDownloadDir()
    const html = `<!DOCTYPE html><p>report</p><script>
      for (const [href, name] of [
        [URL.createObjectURL(new Blob(['pwned'])), 'slay-f1-blob.txt'],
        ['data:text/plain,pwned', 'slay-f1-data.txt']
      ]) {
        const a = document.createElement('a'); a.href = href; a.download = name
        document.body.appendChild(a); a.click()
      }
    </script><img src="${server.origin()}/slow.png">`
    const pdf = await renderPdf(BROWSER as string, html, {
      waitReady: false,
      browser: { commandTimeoutMs: 30_000, downloadDir: downloads }
    })
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    // The slow image kept the page loading for 2 s: time for a download to land.
    await new Promise((r) => setTimeout(r, 1_000))
    expectNothingSaved()
  })

  // Follow-up N4: an <a download> to an http(s) URL is a download too, not a navigation:
  // denied (its request blocked, nothing fetched) and the export goes on, as on desktop.
  // On load and in beforeprint (during printToPDF).
  test('an <a download> click to an http URL (on load, in beforeprint) saves nothing; the PDF is produced', {
    timeout: 90_000
  }, async () => {
    seedDownloadDir()
    server.hits.length = 0
    const html = `<!DOCTYPE html><p>report</p><script>
      function save(path) {
        const a = document.createElement('a'); a.href = '${server.origin()}' + path; a.download = 'slay-f1-http.txt'
        document.body.appendChild(a); a.click()
      }
      save('/file?on-load')
      addEventListener('beforeprint', () => save('/file?in-beforeprint'))
    </script><img src="${server.origin()}/slow.png">`
    const pdf = await renderPdf(BROWSER as string, html, {
      waitReady: false,
      browser: { commandTimeoutMs: 30_000, downloadDir: downloads }
    })
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    await new Promise((r) => setTimeout(r, 1_000))
    expectNothingSaved()
    expect(server.hits.filter((h) => h.startsWith('/file'))).toEqual([])
  })

  // A navigation of the document itself (here: to a data: URL Chrome turns into a
  // download): refused, and the export fails — it never prints another page (F2).
  test('a data: navigation that would download saves nothing; the export fails clearly', {
    timeout: 90_000
  }, async () => {
    seedDownloadDir()
    const html = `<!DOCTYPE html><p>report</p><script>location.href = 'data:application/octet-stream,pwned'</script><img src="${server.origin()}/slow.png">`
    await expect(
      renderPdf(BROWSER as string, html, {
        waitReady: false,
        browser: { commandTimeoutMs: 30_000, downloadDir: downloads }
      })
    ).rejects.toThrow(/tried to navigate away/)
    await new Promise((r) => setTimeout(r, 1_000))
    expectNothingSaved()
  })
})

/**
 * Review 9, F2 (CLI part): the export document must stay the document the export
 * built. One that navigates itself (meta refresh, `location.href =`) would print
 * another page — an attacker's — and that page's scripts would run with no export
 * policy. Every such navigation is refused before anything is requested, and the
 * export fails with a clear error. Navigations within the document (fragment, history
 * API) and a child frame's own navigations stay allowed.
 */
describe.skipIf(!BROWSER)('the export document cannot navigate itself (review 9, F2)', () => {
  const server = localServer()
  beforeAll(() => server.start())
  afterAll(() => server.stop())
  const opts = {
    // The ready wait gives a navigation queued for after load (a meta refresh) time to
    // start before printing: the flag is never set, so it waits the full budget.
    waitReady: true,
    readyTimeoutMs: 5_000,
    browser: { commandTimeoutMs: 30_000 }
  }

  for (const [name, html] of [
    [
      'a meta refresh to an http URL',
      () =>
        `<!DOCTYPE html><meta http-equiv="refresh" content="0;url=${server.origin()}/meta"><p>x</p>`
    ],
    [
      "location.href = 'data:…'",
      () =>
        `<!DOCTYPE html><p>x</p><script>location.href = 'data:text/html,<p>attacker</p>'</script>`
    ],
    [
      'location.href = a local http server',
      () => `<!DOCTYPE html><p>x</p><script>location.href = '${server.origin()}/'</script>`
    ],
    [
      'location.href = a download from a local http server',
      () => `<!DOCTYPE html><p>x</p><script>location.href = '${server.origin()}/file'</script>`
    ],
    [
      'a navigation started from a timer after load',
      () =>
        `<!DOCTYPE html><p>x</p><script>addEventListener('load', () => setTimeout(() => { location.href = '${server.origin()}/late' }, 50))</script>`
    ],
    [
      'a blob: document',
      () =>
        `<!DOCTYPE html><p>x</p><script>location.href = URL.createObjectURL(new Blob(['<p>attacker</p>'], { type: 'text/html' }))</script>`
    ]
  ] as const) {
    test(`${name}: the export fails, nothing is requested`, { timeout: 90_000 }, async () => {
      server.hits.length = 0
      await expect(renderPdf(BROWSER as string, html(), opts)).rejects.toThrow(
        /The document tried to navigate away/
      )
      expect(server.hits).toEqual([])
    })
  }

  test('navigations within the document, a refresh due later, a child frame’s own: still export', {
    timeout: 90_000
  }, async () => {
    server.hits.length = 0
    server.log.length = 0
    const diag = diagnostics('navigations test')
    // The refresh (a dashboard's) is due long after the export is done.
    const html = `<!DOCTYPE html><meta http-equiv="refresh" content="600"><p>x</p><iframe id="f" src="${server.origin()}/frame"></iframe><script>
      location.hash = '#a'; history.pushState({}, '', '#b')
      addEventListener('load', () => { document.getElementById('f').src = '${server.origin()}/frame2' })
    </script>`
    await diag.report(
      async () => {
        const pdf = await renderPdf(BROWSER as string, html, {
          ...opts,
          readyTimeoutMs: 3_000,
          browser: { ...opts.browser, debug: diag.debug }
        })
        expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
        expect(server.hits).toContain('/frame')
        expect(server.hits).toContain('/frame2')
      },
      async () => [
        `server origin ${server.origin()}`,
        ...server.log,
        ...(await frameProbes(server))
      ]
    )
  })

  // CI round 2: a cross-site child frame loads in a process of its own, and
  // `document.readyState` turns complete without waiting for it — the export printed
  // before such a frame had loaded (on a busy machine, before it was even requested).
  // Desktop's export waits for the load event (did-finish-load), which does wait.
  test('a child frame that loads slowly has loaded before the export prints', {
    timeout: 90_000
  }, async () => {
    server.hits.length = 0
    server.log.length = 0
    const diag = diagnostics('slow child frame test')
    const html = `<!DOCTYPE html><p>x</p><iframe src="${server.origin()}/slow-frame"></iframe>`
    await diag.report(
      async () => {
        const pdf = await renderPdf(BROWSER as string, html, {
          waitReady: false,
          browser: { commandTimeoutMs: 30_000, debug: diag.debug }
        })
        expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
        expect(server.hits).toContain('served /slow-frame')
      },
      async () => [
        `server origin ${server.origin()}`,
        ...server.log,
        ...(await frameProbes(server))
      ]
    )
  })
})

/**
 * Review 9, L1: printable reports call `print()` on load. The export's own print is
 * the browser's printToPDF; the page's print() must not get in its way ("Page is
 * already being printed"). Desktop's sandbox makes it a no-op; so does the CLI.
 */
describe.skipIf(!BROWSER)('an html artifact that calls print() (review 9, L1)', () => {
  test('print() on load, on the load event and from a timer while printing: PDF produced', {
    timeout: 90_000
  }, async () => {
    const html = `<!DOCTYPE html><p>printable report</p><script>
      print()
      addEventListener('load', () => print())
      setInterval(() => print(), 1)
      addEventListener('beforeprint', () => print())
    </script><iframe srcdoc="<script>print()</script>"></iframe>`
    const pdf = await renderPdf(BROWSER as string, html, {
      waitReady: false,
      browser: { commandTimeoutMs: 30_000 }
    })
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  })
})
