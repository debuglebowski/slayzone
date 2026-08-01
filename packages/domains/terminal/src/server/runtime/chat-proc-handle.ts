/**
 * The chat spawn seam — the ONE piece a remote runner replaces.
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
 * runner is a byte pipe, and `ChatSessionDriver` — handshake, NDJSON parsing,
 * request correlation — remains the hub's sole responsibility, exactly as
 * `pty-manager` keeps all session logic for routed ptys.
 *
 * @module terminal/server/runtime/chat-proc-handle
 */

import { spawn as realSpawn, type ChildProcess } from 'node:child_process'
import { sanitizeSpawnEnv } from '@slayzone/platform'

/** Unsubscribe token (mirrors node-pty's `IDisposable`). */
export interface ChatDisposable {
  dispose(): void
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
  /** Fires when the process could not be started at all. */
  onError(cb: (err: Error) => void): ChatDisposable
  /** Write raw bytes to stdin. The caller appends any newline it needs. */
  write(data: string): void
  kill(signal?: string): void
}

/** Everything the exec side needs to start one chat agent process. */
export interface ChatSpawnSpec {
  /** `${taskId}:${tabId}`-scoped session key; a routed backend keys by this. */
  sessionId: string
  taskId: string
  /** `null` means "run on the hub". A routing backend reads this to dispatch. */
  runnerId: string | null
  /**
   * The provider's binary NAME (e.g. `claude`), not an absolute path. Resolution
   * is the responsibility of whoever will run it — the hub's `whichBinary` runs a
   * LOCAL login shell, so a hub-resolved absolute path is meaningless on a
   * runner's filesystem.
   */
  binaryName: string
  args: string[]
  cwd: string
  /** Identity/MCP env overlay for this spawn. */
  env: Record<string, string>
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
  const attach = (
    stream: { on(ev: 'data', cb: (c: Buffer | string) => void): unknown; off?: unknown } | null,
    cb: (chunk: string) => void
  ): ChatDisposable => {
    if (!stream) return { dispose: () => {} }
    const listener = (c: Buffer | string): void => cb(typeof c === 'string' ? c : c.toString())
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
      child.on('error', cb)
      return { dispose: () => void child.off?.('error', cb) }
    },
    write: (data) => {
      try {
        child.stdin?.write(data)
      } catch {
        /* best-effort; a dead pipe surfaces via process exit */
      }
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
      const binary = await deps.whichBinary(spec.binaryName)
      if (!binary) {
        throw new Error(
          `Binary "${spec.binaryName}" not found on PATH. Install it or fix your shell's PATH.`
        )
      }
      return childProcessToHandle(
        spawnFn(binary, spec.args, {
          cwd: spec.cwd,
          env: { ...sanitizeSpawnEnv(process.env), ...spec.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false
        })
      )
    }
  }
}
