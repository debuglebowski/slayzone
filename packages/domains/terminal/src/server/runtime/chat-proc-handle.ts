/**
 * The chat spawn seam — the ONE piece a remote computer replaces.
 *
 * Mirrors the role `PtyBackend`/`PtyHandle` play for terminal mode
 * (`runtime/pty-backend.ts`): the transport owns every bit of session logic
 * (buffering, persistence, broadcast, the state machine, and the protocol
 * driver), and the backend owns only "start this OS process and move bytes".
 *
 * Why a handle rather than `ChildProcess`: a routed spawn has no local
 * `ChildProcess` to hand back — no real streams, no fd. Everything the chat
 * transport actually needs from a subprocess is the six members below, so the
 * seam is narrowed to exactly those. A local spawn is adapted onto it by
 * {@link childProcessToHandle} and behaves identically to before.
 *
 * Line framing deliberately stays HUB-side (see {@link createLineSplitter}): the
 * computer is a byte pipe, and `ChatSessionDriver` — handshake, NDJSON parsing,
 * request correlation — remains the hub's sole responsibility, exactly as
 * `pty-manager` keeps all session logic for routed ptys.
 *
 * @module terminal/server/runtime/chat-proc-handle
 */

import { spawn as realSpawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { childProcessEnv } from '@slayzone/platform'
import { assertHubProcessesEnabled } from '@slayzone/platform/hub-switch-refusal'

/** Unsubscribe token (mirrors node-pty's `IDisposable`). */
export interface ChatDisposable {
  dispose(): void
}

/**
 * Why an agent process could not be started at all:
 *   - `cli-not-installed` — the binary is not on the PATH of the machine that runs it;
 *   - `spawn-refused` — that machine refused the start (path jail, policy, no computer);
 *   - `spawn-failed` — anything else that kept the process from running.
 */
export type ChatSpawnFailureCode = 'cli-not-installed' | 'spawn-refused' | 'spawn-failed'

/** A start failure with a code the chat can show a fix for. */
export interface ChatSpawnError extends Error {
  readonly code: ChatSpawnFailureCode
  /** The binary that is missing (`cli-not-installed`). */
  readonly binary?: string
}

export function chatSpawnError(
  code: ChatSpawnFailureCode,
  message: string,
  binary?: string
): ChatSpawnError {
  return Object.assign(new Error(message), {
    name: 'ChatSpawnError',
    code,
    ...(binary ? { binary } : {})
  }) as ChatSpawnError
}

export function isChatSpawnError(err: unknown): err is ChatSpawnError {
  return (
    err instanceof Error &&
    err.name === 'ChatSpawnError' &&
    typeof (err as { code?: unknown }).code === 'string'
  )
}

/**
 * Why a write did not reach the process:
 *   - `link-down` — the machine running it is unreachable right now; the process
 *     may still be alive, so the same write may be retried (same `writeId`);
 *   - `not-delivered` — the process is gone, replaced, or its stdin is closed.
 */
export type ChatWriteFailureCode = 'link-down' | 'not-delivered'

export interface ChatWriteError extends Error {
  readonly code: ChatWriteFailureCode
}

export function chatWriteError(code: ChatWriteFailureCode, message: string): ChatWriteError {
  return Object.assign(new Error(message), { name: 'ChatWriteError', code }) as ChatWriteError
}

export function isChatWriteError(err: unknown): err is ChatWriteError {
  return (
    err instanceof Error &&
    err.name === 'ChatWriteError' &&
    typeof (err as { code?: unknown }).code === 'string'
  )
}

export interface ChatWriteOptions {
  /**
   * Idempotency key: retrying a write whose outcome is unknown (its confirmation
   * was lost with the link) never delivers it twice.
   */
  writeId?: string
}

/**
 * Everything the chat transport needs from one agent subprocess, local or
 * routed. `onStdout`/`onStderr` deliver RAW chunks (not lines) — framing is the
 * hub's job, so a routed chunk boundary can differ from a local one without
 * changing behavior.
 */
export interface ChatProcHandle {
  /** OS pid, or 0 for a routed spawn until the remote reply lands. */
  readonly pid: number
  /**
   * Process confirmed alive — the canonical "ready" signal, independent of what
   * the agent chooses to emit. Locally this is `ChildProcess`'s `'spawn'` (the
   * kernel has a pid); for a routed spawn it is the remote `proc.spawn` reply.
   * The transport promotes `starting → idle` and starts the protocol driver here,
   * so a handle that never fires it leaves the session stuck until the watchdog
   * reaps it.
   */
  onSpawn(cb: () => void): ChatDisposable
  onStdout(cb: (chunk: string) => void): ChatDisposable
  onStderr(cb: (chunk: string) => void): ChatDisposable
  /** Fires once with the process's terminal status. */
  onExit(cb: (e: { code: number | null; signal: string | null }) => void): ChatDisposable
  /**
   * Fires when the process could not be started at all — a {@link ChatSpawnError}
   * when the cause is known. `onExit` may or may not follow; `onSpawn` never does.
   */
  onError(cb: (err: Error) => void): ChatDisposable
  /**
   * Write raw text to stdin; the caller appends any newline it needs. Resolves once
   * the bytes reached the process, rejects with a {@link ChatWriteError} when they
   * did not — never silently drops.
   */
  write(data: string, opts?: ChatWriteOptions): Promise<void>
  kill(signal?: string): void
}

/** Everything the exec side needs to start one chat agent process. */
export interface ChatSpawnSpec {
  /** `${taskId}:${tabId}`-scoped session key; a routed backend keys by this. */
  sessionId: string
  taskId: string
  /** `null` means "run on the hub". A routing backend reads this to dispatch. */
  computerId: string | null
  /**
   * The provider's binary NAME (e.g. `claude`), not an absolute path. Resolution
   * is the responsibility of whoever will run it — the hub's `whichBinary` runs a
   * LOCAL login shell, so a hub-resolved absolute path is meaningless on a
   * computer's filesystem.
   */
  binaryName: string
  args: string[]
  /**
   * Absolute cwd, or empty to let the COMPUTER resolve it from `projectId`. The
   * hub cannot: it held one path column covering every computer, so it could only
   * ever be right about one of them.
   */
  cwd: string
  /** Lets the computer resolve its own cwd when `cwd` is empty. */
  projectId?: string | null
  /** Identity/MCP env overlay for this spawn. */
  env: Record<string, string>
  /**
   * Agent-start admission lane on the computer (`foreground` = a user action,
   * `background` = a restore). Absent: foreground.
   */
  admission?: 'foreground' | 'background'
}

export interface ChatBackend {
  spawn(spec: ChatSpawnSpec): ChatProcHandle | Promise<ChatProcHandle>
}

/**
 * Split a raw chunk stream into lines, buffering partial tails.
 *
 * Replaces `readline.createInterface({ crlfDelay: Infinity })`, which needs a
 * real stream. Same contract: emit on `\n` or `\r\n`, never emit a partial line,
 * and hold an unterminated tail until more bytes arrive. A provider's NDJSON
 * line can exceed one chunk, so dropping the tail would corrupt the protocol.
 */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      let line = buffer.slice(0, index)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      buffer = buffer.slice(index + 1)
      onLine(line)
      index = buffer.indexOf('\n')
    }
  }
}

/**
 * Adapt a local `ChildProcess` onto {@link ChatProcHandle}. Keeps the in-process
 * path byte-identical to the pre-seam behavior — including tolerating a stdio
 * stream being absent, which the fake children in the transport tests rely on.
 */
export function childProcessToHandle(child: ChildProcess): ChatProcHandle {
  // Without a listener a broken pipe is an unhandled 'error' event that ends the
  // hub. Remembered so later writes are refused instead of attempted.
  let stdinBroken: string | null = null
  child.stdin?.on?.('error', (err: Error) => {
    stdinBroken = err.message
  })
  let exited = false
  child.on('exit', () => {
    exited = true
  })
  const attach = (
    stream: { on(ev: 'data', cb: (c: Buffer | string) => void): unknown; off?: unknown } | null,
    cb: (chunk: string) => void
  ): ChatDisposable => {
    if (!stream)
      return {
        dispose: () => {
          // Nothing was ever attached — this stdio stream is absent on the child.
        }
      }
    // One decoder per subscription: a character split across two reads is held
    // until its last byte arrives, never emitted as U+FFFD.
    const decoder = new StringDecoder('utf8')
    const listener = (c: Buffer | string): void => {
      const text = typeof c === 'string' ? c : decoder.write(c)
      if (text) cb(text)
    }
    stream.on('data', listener)
    return {
      dispose: () => {
        const off = (stream as { off?: (ev: string, l: unknown) => void }).off
        if (typeof off === 'function') off.call(stream, 'data', listener)
      }
    }
  }

  return {
    get pid(): number {
      return child.pid ?? 0
    },
    onSpawn: (cb) => {
      child.on('spawn', cb)
      return { dispose: () => void child.off?.('spawn', cb) }
    },
    onStdout: (cb) => attach(child.stdout as never, cb),
    onStderr: (cb) => attach(child.stderr as never, cb),
    onExit: (cb) => {
      const listener = (code: number | null, signal: NodeJS.Signals | null): void =>
        cb({ code, signal: signal != null ? String(signal) : null })
      child.on('exit', listener)
      return { dispose: () => void child.off?.('exit', listener) }
    },
    onError: (cb) => {
      // ENOENT/EACCES on exec: the binary is not there (or not runnable).
      const listener = (err: NodeJS.ErrnoException): void =>
        cb(
          err.code === 'ENOENT'
            ? chatSpawnError('cli-not-installed', err.message, err.path)
            : err.syscall?.startsWith('spawn')
              ? chatSpawnError('spawn-failed', err.message)
              : err
        )
      child.on('error', listener)
      return { dispose: () => void child.off?.('error', listener) }
    },
    write: (data) => {
      const stdin = child.stdin
      if (!stdin || exited || stdinBroken !== null || stdin.destroyed || stdin.writableEnded) {
        return Promise.reject(
          chatWriteError(
            'not-delivered',
            `stdin is closed${stdinBroken ? ` (${stdinBroken})` : exited ? ' (process exited)' : ''}`
          )
        )
      }
      return new Promise<void>((resolve, reject) => {
        const fail = (err: unknown): void => {
          const message = err instanceof Error ? err.message : String(err)
          stdinBroken ??= message
          reject(chatWriteError('not-delivered', message))
        }
        try {
          stdin.write(data, (err) => (err ? fail(err) : resolve()))
        } catch (err) {
          fail(err)
        }
      })
    },
    kill: (signal) => {
      try {
        child.kill(signal as NodeJS.Signals | undefined)
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * The in-process `ChatBackend` — spawn the agent on THIS machine.
 *
 * Used as the `local` fallback of the routing chat backend, and it is the exact
 * behavior the transport had before the seam existed: resolve the binary on this
 * machine's PATH, sanitize the inherited env, overlay the per-spawn identity env.
 *
 * `whichBinary` is injected rather than imported so this module stays free of the
 * shell-probing machinery (and so tests can resolve without touching a shell).
 */
export function createLocalChatBackend(deps: {
  whichBinary: (name: string) => Promise<string | null>
  spawn?: typeof realSpawn
}): ChatBackend {
  const spawnFn = deps.spawn ?? realSpawn
  return {
    async spawn(spec: ChatSpawnSpec): Promise<ChatProcHandle> {
      // In-process spawn: refused on a hub with processes switched off.
      assertHubProcessesEnabled('hub.process.spawn', {
        op: 'chat.spawn',
        detail: { sessionId: spec.sessionId, taskId: spec.taskId }
      })
      const binary = await deps.whichBinary(spec.binaryName)
      if (!binary) {
        throw chatSpawnError(
          'cli-not-installed',
          `Binary "${spec.binaryName}" not found on PATH. Install it or fix your shell's PATH.`,
          spec.binaryName
        )
      }
      return childProcessToHandle(
        spawnFn(binary, spec.args, {
          cwd: spec.cwd,
          env: childProcessEnv(spec.env),
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false
        })
      )
    }
  }
}
