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
}

export interface Browser {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<T>
  close(): Promise<void>
}

const LAUNCH_TIMEOUT_MS = 30_000
const COMMAND_TIMEOUT_MS = 60_000
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

/** Start `executable` headless and complete a CDP round trip with it. */
export async function launchBrowser(executable: string): Promise<Browser> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-export-profile-'))
  let child: ChildProcess
  try {
    child = spawn(executable, browserArgs(userDataDir), {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']
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
  let exited: Error | null = null
  const failAll = (err: Error) => {
    exited ??= err
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }

  let buffered = ''
  fromBrowser.setEncoding('utf8')
  fromBrowser.on('data', (chunk: string) => {
    buffered += chunk
    let end = buffered.indexOf('\0')
    while (end !== -1) {
      const raw = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      end = buffered.indexOf('\0')
      let msg: { id?: number; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(raw)
      } catch {
        continue
      }
      if (msg.id === undefined) continue // an event; this client polls instead
      const p = pending.get(msg.id)
      if (!p) continue
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'))
      else p.resolve(msg.result ?? {})
    }
  })
  // EPIPE on a browser that died mid-write surfaces through the exit handler.
  const ignore = (): void => undefined
  toBrowser.on('error', ignore)
  fromBrowser.on('error', ignore)

  const exitPromise = new Promise<void>((resolve) => {
    // 'close', not 'exit': it fires after stderr is drained, so the loader's
    // missing-library line is in `stderr` by then.
    child.once('close', (code, signal) => {
      failAll(launchFailure(executable, stderr, signal ? `signal ${signal}` : `exit code ${code}`))
      resolve()
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
  const cleanUpNow = (): void => {
    child.kill('SIGKILL')
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
  const removeHooks = onExitOrSignal(cleanUpNow)

  function send<T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = COMMAND_TIMEOUT_MS
  ): Promise<T> {
    if (exited) return Promise.reject(exited)
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new BrowserLaunchError(`Browser did not answer ${method} within ${timeoutMs} ms`))
      }, timeoutMs)
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      toBrowser.write(`${JSON.stringify({ id, method, params, sessionId })}\0`)
    })
  }

  let closed = false
  async function close(): Promise<void> {
    if (closed) return
    closed = true
    if (!exited) {
      // A browser that ignores Browser.close is killed below.
      send('Browser.close', {}, undefined, 2_000).catch(ignore)
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
      await exitPromise
      clearTimeout(timer)
    }
    removeHooks()
    // Windows may hold profile files for a moment after exit.
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }

  try {
    await send('Browser.getVersion', {}, undefined, LAUNCH_TIMEOUT_MS)
  } catch (err) {
    await close()
    throw err instanceof BrowserLaunchError
      ? err
      : launchFailure(executable, stderr, (err as Error).message)
  }
  return { send, close }
}
