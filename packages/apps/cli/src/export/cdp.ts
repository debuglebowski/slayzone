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
  close(): Promise<void>
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
}

const LAUNCH_TIMEOUT_MS = 30_000
const COMMAND_TIMEOUT_MS = 60_000
const LIVENESS_INTERVAL_MS = 30_000
const EXIT_GRACE_MS = 2_000
const STALL_MS = 5 * 60_000
const STALL_PROBE_INTERVAL_MS = 1_000
const STDERR_KEEP = 16 * 1024

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
  args.push('about:blank')
  return args
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
  const exitGraceMs = opts.exitGraceMs ?? EXIT_GRACE_MS
  const stallMs = opts.stallMs ?? STALL_MS
  const stallProbeIntervalMs = opts.stallProbeIntervalMs ?? STALL_PROBE_INTERVAL_MS
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-export-profile-'))
  // Its own process group (not on Windows): killing the group also ends whatever a
  // wrapper script (`--browser`) started, so nothing outlives `slay`.
  const ownGroup = process.platform !== 'win32'
  let child: ChildProcess
  try {
    child = spawn(executable, browserArgs(userDataDir), {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      detached: ownGroup
    })
  } catch (err) {
    fs.rmSync(userDataDir, { recursive: true, force: true })
    throw launchFailure(executable, '', (err as Error).message)
  }

  let stderr = ''
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-STDERR_KEEP)
  })
  const toBrowser = child.stdio[3] as Writable
  const fromBrowser = child.stdio[4] as Readable

  let nextId = 1
  const pending = new Map<number, Pending>()
  /** Page session → its target, from `Target.attachToTarget`. */
  const sessionTargets = new Map<string, string>()
  /** Sessions whose page died, and why: later commands there fail at once. */
  const deadSessions = new Map<string, Error>()
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
    if (!deadSessions.has(sessionId)) deadSessions.set(sessionId, err)
    sessionTargets.delete(sessionId)
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
  const onEvent = (msg: CdpMessage): void => {
    const params = msg.params ?? {}
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
    const dead = sessionId ? deadSessions.get(sessionId) : undefined
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
      await send('Browser.getVersion', {}, undefined, livenessIntervalMs)
      return true
    }
    const { targetInfos } = await send<{ targetInfos?: Array<{ targetId?: unknown }> }>(
      'Target.getTargets',
      {},
      undefined,
      livenessIntervalMs
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
    }
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
  async function close(): Promise<void> {
    if (closed) return
    closed = true
    if (!exited) {
      // A browser that ignores Browser.close is killed below.
      send('Browser.close', {}, undefined, 2_000).catch(ignore)
      const timer = setTimeout(kill, 5_000)
      await exitPromise
      clearTimeout(timer)
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
    await send('Browser.getVersion', {}, undefined, LAUNCH_TIMEOUT_MS)
  } catch (err) {
    // The launch failure is what to report, not a profile left behind by it.
    await close().catch(ignore)
    throw err instanceof BrowserLaunchError
      ? err
      : launchFailure(executable, stderr, (err as Error).message)
  }
  const onEventListener = (listener: CdpEventListener): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return { send: (m, p, sid) => send(m, p, sid), sendLong, onEvent: onEventListener, close }
}
