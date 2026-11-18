/**
 * A minimal Chrome DevTools Protocol client over `--remote-debugging-pipe`: the
 * browser reads CDP from fd 3 and writes to fd 4, NUL-delimited JSON. Chosen over
 * `--remote-debugging-port` + WebSocket because it opens no TCP port (any local
 * process could drive a port-exposed browser while it runs), needs no
 * DevToolsActivePort polling, and works for browsers whose temp dir is private
 * (snap-packaged Chromium) since nothing is read back from the profile dir.
 * Playwright drives Chromium the same way on every OS.
 *
 * Sessions are flattened (`Target.attachToTarget({ flatten: true })`): page commands
 * carry a `sessionId` on the same pipe.
 *
 * Events are read only to learn that a page died: a renderer that crashes (out of
 * memory on a huge document) never answers the command it was running, while the
 * browser process keeps answering. `Inspector.targetCrashed` (page session, after
 * `Inspector.enable`), `Target.targetCrashed` / `Target.targetDestroyed` (browser
 * level, with discovery on) and `Target.detachedFromTarget` fail every pending command
 * of that page's session at once. Callers may also listen to events ({@link
 * Browser.onEvent}) — the renderer uses that to dismiss JS dialogs.
 *
 * A renderer can also hang without dying: a page script that never yields (one that
 * starts looping only once printing begins, from `beforeprint`). The browser process
 * keeps answering then, so a long page command also probes the page itself (the
 * desktop export's stall watchdog): a trivial `Runtime.evaluate` every second, and one
 * left unanswered for `stallMs` fails the command.
 *
 * And a renderer can crash without the browser hearing of it: on Linux, a crashed
 * process does not exit until the kernel has handed its core to the system's dump
 * handler (`core_pattern` piped to systemd-coredump or apport, which also dump
 * Chrome's non-dumpable renderers: `fs.suid_dumpable=2`, Ubuntu's default). Until then
 * the browser sees a renderer that merely does not answer — for as long as the handler
 * takes, forever for one that stalls. So the page's own process is watched too
 * ({@link Browser.watchProcess}): while a long command runs there, a process that is
 * dumping core, a zombie or gone fails the page as crashed.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { missingLibraryHint, missingSharedLibrary } from './missing-libs'
import { onExitOrSignal } from './signal-cleanup'

export class BrowserLaunchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserLaunchError'
  }
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
  /** The page session the command runs in (none: the browser itself). */
  sessionId?: string
}

/** A browser-to-client message: a reply (`id`) or an event (`method`). */
interface CdpMessage {
  id?: number
  result?: unknown
  error?: { message?: string }
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
}

export class PageGoneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PageGoneError'
  }
}

const pageCrashed = (): PageGoneError =>
  new PageGoneError(
    'The page crashed while rendering (a very large document can run the browser out of memory).'
  )
const pageClosed = (): PageGoneError => new PageGoneError('The page closed while rendering.')
const pageStalled = (method: string, ms: number): PageGoneError =>
  new PageGoneError(
    `The page stopped responding while running ${method}: a script in it did not yield for ${Math.round(ms / 1000)} s.`
  )

export interface Browser {
  /** A command answered within the per-command deadline. */
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<T>
  /**
   * A command whose work grows with the document (printing, capturing): no fixed
   * deadline. Instead the browser is checked for liveness while it works, and (for a
   * page command) the page itself; either one that stops answering fails the command.
   */
  sendLong<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<T>
  /**
   * Every event the browser sends (`sessionId`: the page session it belongs to, none
   * for the browser itself). Returns the function that stops listening.
   */
  onEvent(listener: CdpEventListener): () => void
  /**
   * Give up on page `sessionId`: every command waiting on it, and every later one,
   * fails with `err` (as when the page crashes). For a page found misbehaving. Answers
   * to what the page is held on (a paused request, a dialog) are still delivered.
   */
  failPage(sessionId: string, err: Error): void
  /**
   * Learn which OS process renders page `sessionId` (a one-shot trace names it), so a
   * long command there also fails when that process has crashed while the browser says
   * nothing. Call while the page is idle (right after attaching): the trace needs the
   * renderer's answer. Never fails: a process it cannot name (or that is not this
   * browser's) just goes unwatched.
   */
  watchProcess(sessionId: string): Promise<void>
  /**
   * Shut the browser down and remove its profile. `kill`: end it at once instead of
   * asking it to shut down — an orderly shutdown first lets go of the pages, and a
   * navigation one of them has under way then goes out without its interception.
   */
  close(opts?: { kill?: boolean }): Promise<void>
}

export type CdpEventListener = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string
) => void

export interface LaunchOptions {
  /** Deadline for an ordinary command (default 60 s). */
  commandTimeoutMs?: number
  /** How often a long command checks the browser still answers (default 30 s). */
  livenessIntervalMs?: number
  /**
   * How long one such check may go unanswered before the browser counts as stopped
   * (default: `livenessIntervalMs`). Its own setting: a short interval (tests) must not
   * mean a short deadline, which a loaded machine misses.
   */
  livenessTimeoutMs?: number
  /** After the browser exits, how long its pipes may stay open (default 2 s). */
  exitGraceMs?: number
  /**
   * A page that leaves a probe unanswered this long while a long command runs in it
   * fails the command (default 5 min, as desktop). Long: laying out a huge document
   * keeps the renderer busy, but it answers between layout steps.
   */
  stallMs?: number
  /** How often a long page command probes the page (default 1 s). */
  stallProbeIntervalMs?: number
  /**
   * Where the profile saves a download, should one ever be let through (default: a
   * directory inside the throwaway profile, removed with it). Tests watch their own.
   */
  downloadDir?: string
  /**
   * Diagnostics only (tests, CI): told the launch, every event read, the browser's
   * stderr and what the client decides (the page's process: named or why not, its fate
   * on each look). Set, the browser also logs to stderr. Off by default; never set by
   * the product.
   */
  debug?: DebugHook
}

/** {@link LaunchOptions.debug}: `what` happened, with whatever it is known by. */
export type DebugHook = (what: string, detail?: Record<string, unknown>) => void

/** Chrome's own logging, for {@link LaunchOptions.debug}: errors and network access. */
const DEBUG_ARGS = [
  '--enable-logging=stderr',
  '--v=0',
  '--vmodule=*network_access*=2,*network_service*=1,*private_network*=2'
]

const LAUNCH_TIMEOUT_MS = 30_000
const COMMAND_TIMEOUT_MS = 60_000
const LIVENESS_INTERVAL_MS = 30_000
const EXIT_GRACE_MS = 2_000
const STALL_MS = 5 * 60_000
const STALL_PROBE_INTERVAL_MS = 1_000
const STDERR_KEEP = 16 * 1024

/**
 * Answers to something a page is held on — a paused request, an open dialog. Sent
 * even once the page is given up ({@link Browser.failPage}, a crash): a request left
 * paused is let through when the session ends, a dialog left open stays open. To a
 * page that is truly gone they cost an error reply, nothing more.
 */
const ALWAYS_DELIVERED = new Set([
  'Fetch.failRequest',
  'Fetch.continueRequest',
  'Fetch.fulfillRequest',
  'Page.handleJavaScriptDialog'
])

/**
 * The throwaway profile's preferences, written before the browser starts: downloads go
 * to `downloadDir`, never asked about. The renderer denies downloads over CDP
 * (`Browser.setDownloadBehavior`), but that holds only while a DevTools client is
 * attached — a browser shutting down lets go of it first, and then the profile's own
 * setting decides. Chrome's default is the person's Downloads folder.
 */
export function seedProfile(userDataDir: string, downloadDir: string): void {
  const prefs = {
    download: { default_directory: downloadDir, prompt_for_download: false },
    savefile: { default_directory: downloadDir }
  }
  fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true })
  fs.writeFileSync(path.join(userDataDir, 'Default', 'Preferences'), JSON.stringify(prefs))
}

/** Flags for a throwaway, quiet, headless profile. */
export function browserArgs(userDataDir: string, platform = process.platform): string[] {
  const args = [
    '--headless',
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--hide-scrollbars',
    '--mute-audio',
    '--password-store=basic'
  ]
  if (platform === 'darwin') args.push('--use-mock-keychain')
  // Chromium refuses to start as root with its sandbox on (containers, CI).
  if (platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox')
  // Crashpad stays on. `--disable-crashpad-for-testing` makes Chrome's network service
  // crash on start on Linux ("Crashing due to FD ownership violation", Chrome 157), and
  // restart and crash again in a loop: nothing loads over the network, not even a child
  // frame from 127.0.0.1. A crashed renderer the kernel holds while the system's dump
  // handler takes its core is caught by watching the page's process instead (see the
  // top of this file); crashpad itself, even with its handler stopped, did not keep the
  // renderer from crashing on (checked on Linux, Chrome 157).
  args.push('about:blank')
  return args
}

/** What the OS says about a process: still running, crashed (dumping core), or gone. */
export type ProcessFate = 'running' | 'crashed' | 'gone'

type ReadText = (file: string) => string
const readText: ReadText = (file) => fs.readFileSync(file, 'utf8')
const errCode = (err: unknown): unknown => (err as NodeJS.ErrnoException | null)?.code

/**
 * The fate of process `pid`. Linux reads /proc: `CoreDumping: 1` (status) is a process
 * that crashed and is being dumped, a zombie (stat state Z/X) has exited. Elsewhere only
 * "gone" is known (signal 0). Anything it cannot read is no verdict: "running".
 */
export function processFate(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  read: ReadText = readText
): ProcessFate {
  if (platform !== 'linux') {
    try {
      process.kill(pid, 0)
      return 'running'
    } catch (err) {
      return errCode(err) === 'ESRCH' ? 'gone' : 'running'
    }
  }
  try {
    const stat = read(`/proc/${pid}/stat`)
    // `pid (comm) state …`: comm may hold spaces and parentheses, the last ')' ends it.
    const state = stat.slice(stat.lastIndexOf(')') + 2).charAt(0)
    if (state === 'Z' || state === 'X' || state === 'x') return 'gone'
    return /^CoreDumping:\s*1\s*$/m.test(read(`/proc/${pid}/status`)) ? 'crashed' : 'running'
  } catch (err) {
    return errCode(err) === 'ENOENT' || errCode(err) === 'ESRCH' ? 'gone' : 'running'
  }
}

/**
 * `pid` is one of this browser's processes. On Linux its command line carries the
 * profile flag every Chrome child process is started with — a pid seen from another PID
 * namespace (a browser in a Flatpak sandbox) names some other process here, which must
 * never be taken for the page's. Elsewhere a browser's pids are the system's.
 *
 * Chrome's zygote-forked processes — renderers among them — retitle themselves
 * (setproctitle): `/proc/<pid>/cmdline` is then the whole command line as ONE
 * space-joined string, the rest of the old argv zero-filled. So the flag counts as a
 * whole NUL-separated argument or as a space-bounded token of such a title.
 */
export function ownProcess(
  pid: number,
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
  read: ReadText = readText
): boolean {
  if (platform !== 'linux') return true
  try {
    const flag = ` --user-data-dir=${userDataDir} `
    return read(`/proc/${pid}/cmdline`)
      .split('\0')
      .some((arg) => ` ${arg} `.includes(flag))
  } catch {
    return false
  }
}

/** The renderer process of `targetId` in a trace's `TracingStartedInBrowser` event. */
function tracedProcess(events: unknown, targetId: string): number | undefined {
  if (!Array.isArray(events)) return undefined
  for (const e of events as Array<{ name?: unknown; args?: { data?: { frames?: unknown } } }>) {
    if (e?.name !== 'TracingStartedInBrowser') continue
    const frames = e.args?.data?.frames
    if (!Array.isArray(frames)) continue
    for (const f of frames as Array<{ frame?: unknown; processId?: unknown }>) {
      // A page target's id is its main frame's id.
      if (f?.frame === targetId && typeof f.processId === 'number' && f.processId > 0) {
        return f.processId
      }
    }
  }
  return undefined
}

/** Every frame → process pair in a trace's `TracingStartedInBrowser` events (debug). */
function tracedFrames(events: unknown): unknown[] {
  if (!Array.isArray(events)) return []
  return events
    .filter((e) => (e as { name?: unknown })?.name === 'TracingStartedInBrowser')
    .flatMap((e) => {
      const frames = (e as { args?: { data?: { frames?: unknown } } }).args?.data?.frames
      return Array.isArray(frames) ? frames : []
    })
}

/** What /proc says about `pid` (debug): its state, core dump, namespaces, command. */
function processFacts(pid: number): Record<string, unknown> {
  if (process.platform !== 'linux') return {}
  const facts: Record<string, unknown> = {}
  try {
    const status = readText(`/proc/${pid}/status`)
    for (const key of ['Name', 'State', 'PPid', 'NSpid', 'CoreDumping', 'TracerPid']) {
      facts[key] = status.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1] ?? null
    }
    facts.cmdline = readText(`/proc/${pid}/cmdline`).split('\0').join(' ').slice(0, 300)
  } catch (err) {
    facts.procError = errCode(err) ?? (err as Error).message
  }
  return facts
}

function launchFailure(executable: string, stderr: string, cause: string): BrowserLaunchError {
  const lib = missingSharedLibrary(stderr)
  if (lib) return new BrowserLaunchError(missingLibraryHint(lib))
  const tail = stderr.trim().split('\n').slice(-8).join('\n')
  return new BrowserLaunchError(
    `The browser could not start (${cause}): ${executable}${tail ? `\n${tail}` : ''}`
  )
}

/**
 * Splits the browser's NUL-terminated messages. Linear in the bytes received: each
 * chunk is scanned once and a message is joined only when its terminator arrives,
 * so a multi-MB reply never costs a rescan of everything buffered so far.
 */
export class CdpFrameReader {
  private parts: string[] = []
  constructor(private readonly onMessage: (raw: string) => void) {}
  push(chunk: string): void {
    let start = 0
    for (let end = chunk.indexOf('\0'); end !== -1; end = chunk.indexOf('\0', start)) {
      this.parts.push(chunk.slice(start, end))
      const raw = this.parts.join('')
      this.parts = []
      this.onMessage(raw)
      start = end + 1
    }
    if (start < chunk.length) this.parts.push(chunk.slice(start))
  }
}

/** Start `executable` headless and complete a CDP round trip with it. */
export async function launchBrowser(
  executable: string,
  opts: LaunchOptions = {}
): Promise<Browser> {
  const commandTimeoutMs = opts.commandTimeoutMs ?? COMMAND_TIMEOUT_MS
  const livenessIntervalMs = opts.livenessIntervalMs ?? LIVENESS_INTERVAL_MS
  const livenessTimeoutMs = opts.livenessTimeoutMs ?? livenessIntervalMs
  const exitGraceMs = opts.exitGraceMs ?? EXIT_GRACE_MS
  const stallMs = opts.stallMs ?? STALL_MS
  const stallProbeIntervalMs = opts.stallProbeIntervalMs ?? STALL_PROBE_INTERVAL_MS
  const debug = opts.debug
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-export-profile-'))
  // Its own process group (not on Windows): killing the group also ends whatever a
  // wrapper script (`--browser`) started, so nothing outlives `slay`.
  const ownGroup = process.platform !== 'win32'
  let child: ChildProcess
  try {
    seedProfile(userDataDir, opts.downloadDir ?? path.join(userDataDir, 'downloads'))
    const args = browserArgs(userDataDir)
    // Before the page URL, which `browserArgs` puts last.
    if (debug) args.splice(-1, 0, ...DEBUG_ARGS)
    child = spawn(executable, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      detached: ownGroup
    })
    debug?.('launch', { executable, args, pid: child.pid, userDataDir })
  } catch (err) {
    fs.rmSync(userDataDir, { recursive: true, force: true })
    throw launchFailure(executable, '', (err as Error).message)
  }

  let stderr = ''
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-STDERR_KEEP)
    debug?.('stderr', { text: d.toString() })
  })
  const toBrowser = child.stdio[3] as Writable
  const fromBrowser = child.stdio[4] as Readable

  let nextId = 1
  const pending = new Map<number, Pending>()
  /** Page session → its target, from `Target.attachToTarget`. */
  const sessionTargets = new Map<string, string>()
  /** Sessions whose page died, and why: later commands there fail at once. */
  const deadSessions = new Map<string, Error>()
  /** Page session → the OS process rendering it ({@link Browser.watchProcess}). */
  const sessionProcesses = new Map<string, number>()
  let exited: Error | null = null
  const failAll = (err: Error) => {
    exited ??= err
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }

  /** The page behind `sessionId` is gone: fail everything still waiting on it. */
  const failSession = (sessionId: string, err: Error): void => {
    debug?.('page-failed', { sessionId, error: err.message, known: deadSessions.has(sessionId) })
    if (!deadSessions.has(sessionId)) deadSessions.set(sessionId, err)
    sessionTargets.delete(sessionId)
    sessionProcesses.delete(sessionId)
    for (const [id, p] of pending) {
      if (p.sessionId !== sessionId) continue
      pending.delete(id)
      clearTimeout(p.timer)
      p.reject(err)
    }
  }
  const failTarget = (targetId: unknown, err: Error): void => {
    for (const [sid, tid] of [...sessionTargets]) if (tid === targetId) failSession(sid, err)
  }

  const listeners = new Set<CdpEventListener>()
  const onEventListener = (listener: CdpEventListener): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  const onEvent = (msg: CdpMessage): void => {
    const params = msg.params ?? {}
    debug?.('event', { method: msg.method, sessionId: msg.sessionId, params })
    switch (msg.method) {
      case 'Inspector.targetCrashed':
        if (msg.sessionId) failSession(msg.sessionId, pageCrashed())
        break
      case 'Inspector.detached':
        if (msg.sessionId) failSession(msg.sessionId, pageClosed())
        break
      case 'Target.targetCrashed':
        failTarget(params.targetId, pageCrashed())
        break
      case 'Target.targetDestroyed':
        failTarget(params.targetId, pageClosed())
        break
      case 'Target.detachedFromTarget':
        if (typeof params.sessionId === 'string') failSession(params.sessionId, pageClosed())
        break
    }
    if (typeof msg.method !== 'string') return
    for (const listener of [...listeners]) {
      // A listener's bug must not stop the pipe reader (and with it every reply).
      try {
        listener(msg.method, params, msg.sessionId)
      } catch {
        // Ignored: the listener's own concern.
      }
    }
  }

  const reader = new CdpFrameReader((raw) => {
    let msg: CdpMessage
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id === undefined) {
      onEvent(msg)
      return
    }
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'))
    else p.resolve(msg.result ?? {})
  })
  fromBrowser.setEncoding('utf8')
  fromBrowser.on('data', (chunk: string) => reader.push(chunk))
  // EPIPE on a browser that died mid-write surfaces through the exit handler.
  const ignore = (): void => undefined
  toBrowser.on('error', ignore)
  fromBrowser.on('error', ignore)

  const exitPromise = new Promise<void>((resolve) => {
    const ended = (code: number | null, signal: NodeJS.Signals | null): void => {
      debug?.('exit', { code, signal })
      failAll(launchFailure(executable, stderr, signal ? `signal ${signal}` : `exit code ${code}`))
      resolve()
    }
    // 'close' (after stderr is drained, so the loader's missing-library line is in
    // `stderr` by then) — but a child whose pipes outlive it (a wrapper's grandchild)
    // never closes them: after 'exit' plus a grace period, stop waiting and let go
    // of the pipes.
    child.once('close', ended)
    child.once('exit', (code, signal) => {
      setTimeout(() => {
        for (const s of [child.stderr, toBrowser, fromBrowser]) s?.destroy()
        ended(code, signal)
      }, exitGraceMs).unref()
    })
    child.once('error', (err) => {
      failAll(launchFailure(executable, stderr, err.message))
      resolve()
    })
  })

  // A Ctrl-C'd, killed or crashing `slay` must not leave a headless browser or its
  // temp profile behind. Node emits no 'exit' for a signal it has no handler for, so
  // the signals are handled too: clean up, then re-raise so the process still ends
  // the way it was told to.
  const kill = (): void => {
    try {
      if (ownGroup && child.pid) process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
  const cleanUpNow = (): void => {
    kill()
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
  const removeHooks = onExitOrSignal(cleanUpNow)

  function send<T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs: number | null = commandTimeoutMs
  ): Promise<T> {
    if (exited) return Promise.reject(exited)
    const dead =
      sessionId && !ALWAYS_DELIVERED.has(method) ? deadSessions.get(sessionId) : undefined
    if (dead) return Promise.reject(dead)
    const id = nextId++
    const reply = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(id)
          reject(new BrowserLaunchError(`Browser did not answer ${method} within ${timeoutMs} ms`))
        },
        // No deadline: the timer never fires (a long command's liveness check stands in).
        timeoutMs ?? 2_147_483_647
      )
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, sessionId })
      toBrowser.write(`${JSON.stringify({ id, method, params, sessionId })}\0`)
    })
    // Which page a session drives: a crash or detach event names the target.
    if (method === 'Target.attachToTarget' && typeof params.targetId === 'string') {
      const targetId = params.targetId
      reply.then((r) => {
        const sid = (r as { sessionId?: unknown }).sessionId
        if (typeof sid === 'string') sessionTargets.set(sid, targetId)
      }, ignore)
    }
    return reply
  }

  /**
   * One liveness check for a long command: the browser process answers, and (for a
   * page command) the page's target still exists. Both are answered by the browser
   * process, never by the page — a renderer busy printing must not fail the check.
   * Resolves false when the page is gone; rejects when the browser does not answer.
   */
  async function alive(sessionId: string | undefined): Promise<boolean> {
    const targetId = sessionId ? sessionTargets.get(sessionId) : undefined
    if (!targetId) {
      await send('Browser.getVersion', {}, undefined, livenessTimeoutMs)
      return true
    }
    const { targetInfos } = await send<{ targetInfos?: Array<{ targetId?: unknown }> }>(
      'Target.getTargets',
      {},
      undefined,
      livenessTimeoutMs
    )
    return Array.isArray(targetInfos) && targetInfos.some((t) => t?.targetId === targetId)
  }

  /**
   * While a long command runs in page `sessionId`, ask the page a trivial question
   * every `stallProbeIntervalMs`. One left unanswered for `stallMs` means a script holds
   * the renderer: every command of that page fails (the long one with it). The browser
   * is not the one stuck, so it still closes normally afterwards (and is killed if not).
   * Returns the function that stops watching.
   */
  function watchPage(sessionId: string, method: string): () => void {
    let stopped = false
    let next: NodeJS.Timeout | undefined
    let stall: NodeJS.Timeout | undefined
    // The page's process, checked on its own clock: a probe stays unanswered while the
    // renderer works, so the probe loop cannot be the one to look. Gone counts only on a
    // second look: a renderer that exits normally is reported by the browser first.
    const pid = sessionProcesses.get(sessionId)
    debug?.('watch-page', { sessionId, method, pid: pid ?? null })
    let goneBefore = false
    const fate =
      pid === undefined
        ? undefined
        : setInterval(() => {
            const now = processFate(pid)
            debug?.('process-fate', { pid, fate: now, ...processFacts(pid) })
            if (now === 'crashed' || (now === 'gone' && goneBefore)) {
              failSession(sessionId, pageCrashed())
            }
            goneBefore = now === 'gone'
          }, stallProbeIntervalMs)
    fate?.unref()
    const probe = (): void => {
      next = setTimeout(() => {
        if (stopped) return
        stall = setTimeout(() => failSession(sessionId, pageStalled(method, stallMs)), stallMs)
        // The pending command and the browser pipes keep the process alive meanwhile.
        stall.unref()
        // Its own deadline (just past the stall) so an unanswered probe is not kept forever.
        send(
          'Runtime.evaluate',
          { expression: '1', returnByValue: true },
          sessionId,
          stallMs + 1_000
        )
          .catch(ignore)
          .finally(() => {
            clearTimeout(stall)
            if (!stopped) probe()
          })
      }, stallProbeIntervalMs)
      next.unref()
    }
    probe()
    return () => {
      stopped = true
      clearTimeout(next)
      clearTimeout(stall)
      clearInterval(fate)
    }
  }

  async function watchProcess(sessionId: string): Promise<void> {
    const targetId = sessionTargets.get(sessionId)
    if (!targetId) {
      debug?.('watch-process', { sessionId, outcome: 'no target for the session' })
      return
    }
    let pid: number | undefined
    let traced = false
    let complete: () => void = ignore
    const completed = new Promise<void>((resolve) => {
      complete = resolve
    })
    const stopListening = onEventListener((method, params, sid) => {
      if (sid !== sessionId) return
      if (method === 'Tracing.dataCollected') {
        pid ??= tracedProcess(params.value, targetId)
        if (debug) debug('trace-frames', { targetId, frames: tracedFrames(params.value) })
      } else if (method === 'Tracing.tracingComplete') {
        traced = true
        complete()
      }
    })
    let deadline: NodeJS.Timeout | undefined
    try {
      // The category of `TracingStartedInBrowser`, which lists each frame's process.
      await send(
        'Tracing.start',
        {
          traceConfig: { includedCategories: ['disabled-by-default-devtools.timeline'] },
          transferMode: 'ReportEvents'
        },
        sessionId
      )
      await send('Tracing.end', {}, sessionId)
      await Promise.race([
        completed,
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, commandTimeoutMs)
        })
      ])
    } catch (err) {
      // Unnamed: the page goes unwatched (its crash events and stall probe still apply).
      debug?.('watch-process', {
        sessionId,
        outcome: 'trace failed',
        error: (err as Error).message
      })
    } finally {
      clearTimeout(deadline)
      stopListening()
    }
    const own = pid !== undefined && ownProcess(pid, userDataDir)
    if (pid !== undefined && sessionTargets.has(sessionId) && own) {
      sessionProcesses.set(sessionId, pid)
    }
    debug?.('watch-process', {
      sessionId,
      targetId,
      traced,
      pid: pid ?? null,
      ownProcess: own,
      stillAttached: sessionTargets.has(sessionId),
      watched: sessionProcesses.has(sessionId),
      ...(pid !== undefined && !own ? processFacts(pid) : {})
    })
  }

  async function sendLong<T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    // Once the command settles no check may re-arm: a probe still in flight then
    // would otherwise keep polling (and keep `slay` running) after the work is done.
    let settled = false
    let watchdog: NodeJS.Timeout | undefined
    const stalled = new Promise<never>((_, reject) => {
      const check = (): void => {
        if (settled) return
        watchdog = setTimeout(() => {
          alive(sessionId).then(
            (ok) => {
              // The page vanished without an event: fail its commands (this one too).
              if (!ok && sessionId) failSession(sessionId, pageClosed())
              else check()
            },
            () =>
              reject(
                new BrowserLaunchError(`The browser stopped responding while running ${method}`)
              )
          )
        }, livenessIntervalMs)
        // The pending command and the browser pipes keep the process alive meanwhile.
        watchdog.unref()
      }
      check()
    })
    const reply = send<T>(method, params, sessionId, null)
    const unwatchPage = sessionId ? watchPage(sessionId, method) : undefined
    try {
      return await Promise.race([reply, stalled])
    } finally {
      settled = true
      clearTimeout(watchdog)
      unwatchPage?.()
    }
  }

  let closed = false
  async function close(opts: { kill?: boolean } = {}): Promise<void> {
    if (closed) return
    closed = true
    if (!exited) {
      if (opts.kill) {
        kill()
        await exitPromise
      } else {
        // A browser that ignores Browser.close is killed below.
        send('Browser.close', {}, undefined, 2_000).catch(ignore)
        const timer = setTimeout(kill, 5_000)
        await exitPromise
        clearTimeout(timer)
      }
    }
    // Whatever the browser started (a wrapper's children) goes with it.
    if (ownGroup) kill()
    removeHooks()
    // Windows may hold profile files for a moment after exit.
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (err) {
      throw new Error(
        `The browser's temp profile could not be removed; delete it by hand: ${userDataDir} (${(err as Error).message})`
      )
    }
  }

  try {
    const version = await send('Browser.getVersion', {}, undefined, LAUNCH_TIMEOUT_MS)
    debug?.('version', version as Record<string, unknown>)
  } catch (err) {
    // The launch failure is what to report, not a profile left behind by it.
    await close().catch(ignore)
    throw err instanceof BrowserLaunchError
      ? err
      : launchFailure(executable, stderr, (err as Error).message)
  }
  return {
    send: (m, p, sid) => send(m, p, sid),
    sendLong,
    onEvent: onEventListener,
    failPage: failSession,
    watchProcess,
    close
  }
}

/**
 * A new blank page to render in, attached (flattened session) and watched: crash and
 * close events on for every target and on the page's own session, and its renderer
 * process named ({@link Browser.watchProcess}) while it is still idle.
 */
export async function openPage(b: Browser): Promise<{ targetId: string; sessionId: string }> {
  await b.send('Target.setDiscoverTargets', { discover: true })
  const { targetId } = await b.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank'
  })
  const { sessionId } = await b.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true
  })
  // Inspector.targetCrashed / Inspector.detached on the page's own session.
  await b.send('Inspector.enable', {}, sessionId)
  await b.watchProcess(sessionId)
  return { targetId, sessionId }
}
