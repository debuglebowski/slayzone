import { createRequire } from 'node:module'
import { join } from 'node:path'
import type * as pty from 'node-pty'
import { assertHubProcessesEnabled } from '@slayzone/platform/hub-switch-refusal'
import { wrapShellWithUlimit } from '../shell-env'

/**
 * Hub/computer split (wave 2, Model A): the OS-level `node-pty` spawn — the ONLY
 * piece a remote computer replaces — pulled behind a backend seam. pty-manager
 * still owns everything else (session state, buffers, DB writes, the -l / shell
 * fallback orchestration) and calls `getPtyBackend().spawn(spec)` at each of its
 * spawn sites (initial + the two onExit recovery re-spawns). Default is the
 * in-process `localPtyBackend`, so behavior is byte-identical until a later wave
 * injects a remote backend via `setPtyBackend`.
 */

/** Everything the exec side needs to spawn one PTY. `computerId === null` means
 *  the session runs locally on the hub (today's only path). A remote backend
 *  reads `computerId`/`sessionId`/`taskId` to route; the local backend ignores
 *  them and just spawns `file`/`args` with `options`. */
export interface PtySpawnSpec {
  sessionId: string
  taskId: string
  computerId: string | null
  /**
   * Which project this session belongs to, so the COMPUTER can resolve its own
   * cwd. The hub cannot: it held one `projects.path` column naming a directory
   * on a machine it does not own, which could only ever be right about one
   * computer.
   *
   * `options.cwd` still wins when set, and legitimately so — a worktree path or
   * a `task.base_dir` override is a directory the computer itself created or was
   * explicitly told about, not a hub guess.
   */
  projectId: string | null
  file: string
  args: string[]
  options: {
    /**
     * Absolute cwd, or empty to let the computer resolve it from `projectId`.
     * Empty + no projectId is a spawn with nowhere to run and is refused.
     */
    cwd: string
    env: Record<string, string>
    cols: number
    rows: number
    name: string
  }
  /** docker/ssh transport spawn — skip the ulimit wrap (the remote side owns
   *  its own env). Mirrors the former `spawnWrappedShell(..., transport)` flag. */
  transport: boolean
  /**
   * How long the session may stay silent after it starts before it counts as hung
   * (no output at all ⇒ killed, and pty-manager's normal exit path decides on a
   * recovery shell).
   *
   * Handed to the backend because the deadline belongs to whoever OWNS the
   * process. A remote hub judging silence across a socket cannot tell "printed
   * nothing" from "printed, but I have not read it yet" — after a hub stall it
   * killed healthy agents whose output was already waiting in its own buffers. A
   * backend that arms it says so via `whenSpawned` (`ownsStartupDeadline`);
   * otherwise pty-manager keeps arming its own.
   */
  startupTimeoutMs?: number
  /**
   * Agent-start admission lane: the owner starts this spawn through its admission
   * queue (a few agent starts at a time, the visible tab first) instead of at
   * once. Set for an agent's INITIAL spawn only — never for a plain shell or a
   * recovery shell. `whenSpawned` resolves when it has actually started, and the
   * startup deadline counts from then. Ignored by the local backend.
   */
  admission?: PtySpawnAdmission
}

/** See {@link PtySpawnSpec.admission}. */
export type PtySpawnAdmission = 'foreground' | 'background'

/** How a spawn was confirmed by whoever owns the process. */
export interface PtySpawnConfirmation {
  pid: number | null
  /**
   * The owner armed the spec's `startupTimeoutMs` itself, so the caller must not
   * run a second, worse-placed deadline of its own. Absent/false: nothing on the
   * other end owns one (an older computer), and the caller keeps its own.
   */
  ownsStartupDeadline?: boolean
}

/**
 * A pty exit. `reason` names a lifecycle cause the exit code alone cannot carry:
 * the owner's `startup-timeout`, or a transport outcome (`spawn-failed`,
 * `computer-restarted`, `reattach-timeout`, `exited-while-detached`).
 */
export interface PtyExit {
  exitCode: number
  signal?: number
  reason?: string
}

/**
 * Structural superset of node-pty's `IPty`, limited to the members pty-manager
 * actually touches — verified against every `.pid` / `.process` / `.fd` /
 * `.onData` / `.onExit` / `.write` / `.resize` / `.kill` site in pty-manager.ts
 * (it never calls `.pause` / `.resume` / `.clear` / `.on`). A local spawn
 * returns the raw IPty, which already satisfies this, so downstream code is
 * unchanged. A remote backend returns a proxy of the same shape with `fd`
 * undefined — so the sync-query `writeSync(fd)` path throws and falls through to
 * its `pty.write()` fallback naturally, no remote-specific branch needed.
 */
export interface PtyHandle {
  /**
   * `null` means NOT YET KNOWN, never "dead".
   *
   * A local spawn knows its pid the instant `pty.spawn` returns. A remote one
   * cannot: the handle is created when the request is SENT, and the pid arrives
   * with the computer's reply. Typed nullable so that distinction is impossible to
   * skip — reading an unknown pid as a dead process is exactly how a batch of
   * healthy sessions gets buried on a slow reply (see `whenSpawned`).
   */
  readonly pid: number | null
  /**
   * Resolves when the spawn is CONFIRMED by whoever owns the process, carrying
   * the pid it ended up with; rejects if that owner refused it.
   *
   * Absent on a synchronous backend, where the spawn has already happened by the
   * time the handle exists and `pid` is authoritative immediately. Present on any
   * backend whose spawn is a round-trip, so callers can await the fact instead of
   * guessing with a timer — no timeout tuned on one machine, one computer load or
   * one batch size can be wrong on another.
   */
  readonly whenSpawned?: Promise<PtySpawnConfirmation>
  readonly process: string
  readonly fd?: number
  onData(cb: (data: string) => void): { dispose(): void }
  onExit(cb: (e: PtyExit) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface PtyBackend {
  spawn(spec: PtySpawnSpec): PtyHandle | Promise<PtyHandle>
  /**
   * Promote a computer's pre-warmed session into a real one (warm pool, Phase 6).
   *
   * NOT a spawn: the computer rekeys the process it already booted, so pid, output
   * buffer and seq counter all carry over and the handle returned here is an
   * ordinary routed session from that point on. `processName` is cosmetic — it
   * populates `PtyHandle.process`, which the warm path cannot infer from a spec.
   *
   * Optional because only the ROUTING backend can do it; the local backend has
   * no warm pool of its own (that is the point — warm agents live on computers).
   */
  adopt?(
    computerId: string,
    warmId: string,
    sessionId: string,
    processName: string
  ): Promise<PtyHandle>
  /**
   * Pre-boot a warm session on `computerId`. It buffers output but streams nothing
   * until `adopt` gives it a real session id — the hub has nowhere to route it to
   * before then.
   */
  warmSpawn?(
    computerId: string,
    spec: {
      warmId: string
      command: string
      args: string[]
      cwd: string
      env: Record<string, string>
      /** Written to the shell's stdin post-spawn, to `exec` the agent inside it. */
      postSpawnCommand?: string
    }
  ): Promise<{ pid: number }>
  warmKill?(computerId: string, warmId: string): Promise<void>
  /** Warm sessions the computer still holds — used to reap orphans on reconnect. */
  warmList?(computerId: string): Promise<Array<{ warmId: string; cwd: string; pid: number }>>
  /**
   * The user revealed this session: if its spawn is still waiting for an
   * agent-start slot ({@link PtySpawnSpec.admission}), start it next. Best-effort
   * and fire-and-forget — a session that already started is unaffected.
   */
  prioritize?(sessionId: string): void
}

/**
 * The in-process spawn primitive (identical to the former `spawnWrappedShell`):
 * non-transport spawns are wrapped in `/bin/sh -c 'ulimit -n 65535; exec
 * <shell> <args>'` so child processes inherit a soft fd limit high enough for
 * Bun-compiled CLIs (e.g. droid); transport (docker/ssh) spawns run as-is.
 * Exported so pty-manager's warm-pool `spawnLoginShell` shares the exact same
 * primitive rather than duplicating the wrap logic.
 */
export function spawnLocalPty(
  file: string,
  args: string[],
  options: pty.IPtyForkOptions,
  transport: boolean
): pty.IPty {
  const { spawn } = loadNodePty()
  if (transport) return spawn(file, args, options)
  const wrapped = wrapShellWithUlimit(file, args)
  return spawn(wrapped.file, wrapped.args, options)
}

/**
 * A local spawn on a hub whose node-pty is missing or does not load. node-pty is an
 * OPTIONAL dependency of the published `@slayzone/hub` (T-30): `npm install` skips it
 * when it cannot be built (no compiler), and a hub with
 * `SLAYZONE_HUB_ENABLE_PROCESSES=0` never spawns locally anyway.
 */
export class NodePtyUnavailableError extends Error {
  readonly code = 'NODE_PTY_UNAVAILABLE'

  constructor(cause: unknown) {
    super(
      'Terminals and agents cannot start in this hub process: node-pty is not installed ' +
        `or does not load here (${cause instanceof Error ? cause.message : String(cause)}). ` +
        'It is an optional dependency of @slayzone/hub, skipped when it cannot be built. ' +
        'Run them on a connected computer, or reinstall the hub where node-pty builds.',
      { cause }
    )
    this.name = 'NodePtyUnavailableError'
  }
}

let nodePty: typeof pty | undefined

/**
 * node-pty, loaded on the first local spawn rather than at import. An import-time load
 * is a top-level `require` in the hub's CJS bundle, which kills the boot of a hub that
 * has no node-pty — including one that would never spawn (processes off). Not cached on
 * failure, so a later spawn retries.
 */
function loadNodePty(): typeof pty {
  if (nodePty) return nodePty
  try {
    nodePty =
      typeof require === 'function'
        ? // CJS bundle (the hub): esbuild keeps this call where it is, external, so it
          // resolves at first use — from the bundle's node_modules or NODE_PATH (the
          // desktop's packaged sidecar) exactly like the import it replaces.
          (require('node-pty') as typeof pty)
        : // Unbundled ESM source (tests under tsx/vitest): no `require` in scope, and
          // `import.meta` is off limits — the hub's CJS bundle compiles this file too,
          // where esbuild warns about it and empties it. Resolve from the entry script
          // instead: in this repo it sits below the hoisted root node_modules.
          (createRequire(process.argv[1] ?? join(process.cwd(), 'index.js'))(
            'node-pty'
          ) as typeof pty)
  } catch (err) {
    throw new NodePtyUnavailableError(err)
  }
  return nodePty
}

/** Default backend: spawn in-process via node-pty. The returned raw IPty is a
 *  structural `PtyHandle`, so callers keep it as-is. Synchronous — the -l /
 *  shell fallbacks in pty-manager rely on a synchronous spawn (and their onExit
 *  recovery re-spawns run inside a synchronous callback).
 *
 *  Refused on a hub with `SLAYZONE_HUB_ENABLE_PROCESSES=0`: this backend is active
 *  until the composition root installs the routing one, and a terminal or agent
 *  must never start in the hub's own process meanwhile. */
export const localPtyBackend: PtyBackend = {
  spawn(spec: PtySpawnSpec): PtyHandle {
    assertHubProcessesEnabled('hub.process.spawn', {
      op: 'pty.spawn',
      detail: { sessionId: spec.sessionId, taskId: spec.taskId }
    })
    return spawnLocalPty(spec.file, spec.args, spec.options, spec.transport)
  }
}

// Active backend. Callers re-read this ref on EVERY spawn, so a swap only takes
// effect for spawns issued after it — never mid-session. Swap ONLY at a boot or
// reconnect quiesce point (no in-flight spawn/exit for a session that could
// straddle two backends).
//
// The default remains `localPtyBackend` so TESTS (and any harness that never
// wires a composition root) keep spawning in-process. In the real app the
// composition root installs the routing backend, which requires a computer and has
// no local fallback — see `NoComputerAvailableError`. `setPtyBackend(null)`
// therefore means "restore the test/default in-process backend", NOT "fall back
// to local for a routed session": once the routing backend is installed, nothing
// resets it, so a null computer is an error rather than a silent hub spawn.
let ptyBackend: PtyBackend = localPtyBackend

export function getPtyBackend(): PtyBackend {
  return ptyBackend
}

export function setPtyBackend(backend: PtyBackend | null): void {
  ptyBackend = backend ?? localPtyBackend
}
