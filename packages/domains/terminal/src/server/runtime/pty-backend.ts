import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'
import type { ActivityState, ErrorInfo, PromptInfo } from '../adapters/types'
import type { PtyInputFacts } from '../pty-input'
import type { TerminalTheme } from '../sync-query-response'
import type { BufferSinceResult } from '@slayzone/terminal-contracts'

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
  /** Command to run inside the computer's own login shell. Undefined for a plain shell. */
  computerShellCommand?: string
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
  /**
   * Ask the process owner to run output detection itself and report it as
   * {@link PtySignal}s (`PtyHandle.onSignal`) — the owner sees the output; the hub
   * then mirrors state instead of parsing a copy. An owner that cannot (local
   * backend, an older computer or retained session host) leaves
   * `PtyHandle.detectsOutput` false and the caller keeps detecting.
   */
  detection?: PtyDetectionSpec
  /**
   * This spawn continues the session's output (the recovery shell after an agent
   * exit): the owner keeps the previous process's scrollback, adds `preamble`, and
   * the new output follows it. Ignored by an owner that keeps no output.
   */
  carryOutput?: { preamble: string }
  /**
   * Stream the output to this side now (someone watches the session). False: the
   * owner only buffers + detects it until `PtyHandle.setRelay(true)`. Ignored by an
   * owner that always streams.
   */
  relay?: boolean
}

/** What output detection needs for one session (mirrors `PtyOutputDetector` options). */
export interface PtyDetectionSpec {
  mode: string
  type?: string
  patterns?: { working?: string | null; error?: string | null }
  resuming: boolean
  /** The conversation being resumed: the owner checks its transcript at a failed exit. */
  resumeConversationId?: string
  /** The spawn-time transcript lookup's answer, when one was made (see frames.ts). */
  resumeTranscript?: 'found' | 'missing' | 'unknown'
  /** What OSC colour queries are answered with (`setTerminalTheme`). */
  theme?: TerminalTheme
}

/** One chunk's detection, reported by the owner (see `PtyOutputDetection`). */
export interface PtySignal {
  /** Owner's seq of the output chunk it came from. */
  seq: number
  /**
   * Not one chunk: the owner's settled view after the hub was away (reattach).
   * Applied as-is — no two-detection gate — and only new dev URLs are announced.
   */
  snapshot?: true
  activity: ActivityState | null
  refreshIdleClock: boolean
  /** The idle-clock output happened this long before the signal (coalesced). */
  idleClockAgoMs?: number
  preview: string
  error: ErrorInfo | null
  /** A failed resume's cause, sent just before the exit (sets the error, no transition). */
  exitError?: ErrorInfo
  /** The session's first output (sent even when nothing is relayed). */
  firstOutput?: true
  suppressOutput: boolean
  prompt: PromptInfo | null
  title: string | null
  devServerUrls: string[]
  conversationId: string | null
}

/** Per-write hints for the process owner. */
export interface PtyWriteOptions {
  /** This write submits the session-id command (`/status`): watch for an id. */
  watchConversationId?: true
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
  /** The owner's own words for `reason`: on `spawn-failed`, the computer's refusal. */
  detail?: string
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
  /** `seq`: the owner's seq for the chunk, when it {@link ownsOutput}. */
  onData(cb: (data: string, seq?: number) => void): { dispose(): void }
  onExit(cb: (e: PtyExit) => void): { dispose(): void }
  write(data: string, opts?: PtyWriteOptions): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  /**
   * The owner runs the spec's `detection` (it acknowledged it): output from here on
   * is detected THERE and arrives as `onSignal`; the caller must not detect it too.
   * Absent/false until acknowledged, and always on a backend that cannot.
   */
  readonly detectsOutput?: boolean
  /**
   * What writes a client sent straight to the owner meant (docs/direct-link.md):
   * the caller applies them as it applies a write of its own.
   */
  onInput?(cb: (facts: PtyInputFacts) => void): { dispose(): void }
  /** Detections reported by the owner, for output the caller did not detect itself. */
  onSignal?(cb: (signal: PtySignal) => void): { dispose(): void }
  /**
   * The owner's buffer is the session's ONLY scrollback: every chunk came through
   * its pipeline and carries its seq (`onData`), and replay is read from it
   * ({@link getReplay}). The caller keeps no copy. False/absent: the caller buffers.
   */
  readonly ownsOutput?: boolean
  /**
   * The connected computer that runs this session (a routed backend), for clients
   * that reach it directly (docs/direct-link.md). Absent on a local backend.
   */
  readonly computerId?: string
  /** Replay from the owner's buffer (see `BufferSinceResult`). With {@link ownsOutput}. */
  getReplay?(afterSeq: number): Promise<BufferSinceResult>
  /** Clear the owner's buffer. With {@link ownsOutput}. */
  clearOutput?(): Promise<{ clearedSeq: number }>
  /**
   * Start/stop streaming output to this side (see `PtySpawnSpec.relay`). Rejects when
   * the owner did not apply it (unreachable, refused).
   */
  setRelay?(on: boolean): Promise<void> | void
  /**
   * The owner went unreachable (false; the process may well still run) or came
   * back (true). While away, an owner-held scrollback cannot be read.
   */
  onAvailability?(cb: (available: boolean) => void): { dispose(): void }
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
    processName: string,
    taskId?: string,
    /** Run output detection on the computer from adoption on (see `PtySpawnSpec`). */
    detection?: PtyDetectionSpec,
    /** See `PtySpawnSpec.relay`. */
    relay?: boolean
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
  /** The hub's terminal theme changed: tell every owner that answers terminal queries. */
  setTheme?(theme: TerminalTheme): void
  /** Warm sessions the computer still holds — used to reap orphans on reconnect. */
  warmList?(computerId: string): Promise<Array<{ warmId: string; cwd: string; pid: number }>>
  /**
   * The user revealed this session: if its spawn is still waiting for an
   * agent-start slot ({@link PtySpawnSpec.admission}), start it next. Best-effort
   * and fire-and-forget — a session that already started is unaffected.
   */
  prioritize?(sessionId: string): void
  /**
   * Which of claude's background jobs still have a live process under this
   * session (claude fires no hook when one exits on its own). Resolves `null`
   * when nothing can tell — no owner for the session, a platform that can't
   * inspect processes, a computer that predates the request — and the caller
   * then treats every job as finished. Rejects on a transient failure (lost
   * connection): the caller keeps what it had and asks again.
   *
   * Optional: only the routing backend can answer; agents never run hub-local.
   */
  probeBackgroundJobs?(sessionId: string, jobs: BackgroundJobQuery[]): Promise<string[] | null>
  /**
   * Doctor's facts about `computerId`, the machine the agent starts on: what is
   * wrong with its node-pty install, whether `shell` exists there, and where each
   * of `binaries` resolves on its PATH. Resolves `null` when nothing can tell (a
   * computer that predates the request); rejects when it can't be reached.
   *
   * Optional: only the routing backend can answer; agents never run hub-local.
   */
  doctor?(
    computerId: string,
    ask: { shell: string; binaries: string[] }
  ): Promise<ComputerDoctorFacts | null>
}

/** What a computer reports about itself for Doctor — see {@link PtyBackend.doctor}. */
export interface ComputerDoctorFacts {
  /** Why node-pty can't start ptys there; empty when it can. */
  problems: PtyRuntimeProblem[]
  shellExists: boolean
  binaries: { binary: string; path: string | null }[]
}

/** One reason a computer can't start ptys, shaped as a Doctor row. */
export interface PtyRuntimeProblem {
  /** Unique per problem kind. */
  check: string
  detail: string
  /** A shell command that repairs it. */
  fix: string
}

/** One claude background job as the hook route knows it — see `agent-tree.ts`. */
export interface BackgroundJobQuery {
  id: string
  kind: 'shell' | 'monitor'
  command: string | null
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

/**
 * The hub's default backend: none. Terminals and agents start on computers — the
 * composition root installs the routing backend — so until then, and wherever no
 * computer resolves, a spawn is the actionable "connect a computer"; nothing ever
 * starts in the hub's own process. The in-process node-pty backend lives in
 * ./pty-backend-local for hosts that spawn themselves (tests).
 */
export const noComputerPtyBackend: PtyBackend = {
  spawn(spec: PtySpawnSpec): PtyHandle {
    return refuseNoComputer({
      op: 'pty.spawn',
      detail: { sessionId: spec.sessionId, taskId: spec.taskId }
    })
  }
}

// Active backend. Callers re-read this ref on EVERY spawn, so a swap only takes
// effect for spawns issued after it — never mid-session. Swap ONLY at a boot or
// reconnect quiesce point (no in-flight spawn/exit for a session that could
// straddle two backends).
//
// The default is no backend ("connect a computer"); the composition root installs
// the routing one, a test that spawns real ptys installs `localPtyBackend`
// (./pty-backend-local). `setPtyBackend(null)` restores the refusing default.
let ptyBackend: PtyBackend = noComputerPtyBackend

export function getPtyBackend(): PtyBackend {
  return ptyBackend
}

export function setPtyBackend(backend: PtyBackend | null): void {
  ptyBackend = backend ?? noComputerPtyBackend
}
