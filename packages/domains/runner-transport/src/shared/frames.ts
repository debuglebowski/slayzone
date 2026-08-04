/**
 * Runner wire contract — zod schemas for every frame exchanged between a hub
 * and its runners over the duplex JSON-RPC channel.
 *
 * Versioning: the contract is versioned via `protocolVersion` carried in the
 * `enroll` request. A hub rejects enrollment from a runner speaking a
 * different major protocol version with `RunnerTransportErrorCodes.protocolMismatch`.
 * Reconnects (`hello`) reuse credentials minted at enroll time, so the
 * version negotiated at enrollment governs the session.
 *
 * Direction map (v1):
 *  runner → hub requests:      enroll, hello, heartbeat
 *  runner → hub notifications: pty.data, pty.exit, proc.data, proc.exit,
 *                              event, checkout.status
 *  hub → runner requests:      pty.spawn, pty.kill, pty.resize, pty.write,
 *                              pty.getBufferSince, git.isGitRepo,
 *                              git.getCurrentBranch, git.createWorktree,
 *                              git.removeWorktree, git.runWorktreeSetupScript,
 *                              git.copyIgnoredFiles, fs.pathExists,
 *                              fs.removeDir, proc.spawn, proc.kill, ping,
 *                              runner.shutdown
 *
 * `pty.data.seq` is a per-session monotonic sequence number assigned by the
 * runner at emission and preserved end-to-end, so the hub can detect gaps and
 * request replay via `pty.getBufferSince`.
 *
 * @module runner/shared/frames
 */

import { z } from 'zod'

/**
 * Runner process exit code meaning "the hub no longer recognizes this runner".
 *
 * 78 = EX_CONFIG (sysexits.h): a configuration problem a restart cannot fix. A
 * supervisor must NOT respawn on this — the hub has lost this runner's identity
 * (storage deleted, one of its two DBs restored without the other, or the runner
 * revoked) and only an operator enrolling it again resolves it. Lives here so the
 * runner that exits with it and the supervisor that reads it cannot disagree.
 */
export const RUNNER_EXIT_NEEDS_RE_ENROLLMENT = 78

/** Bump on any breaking change to the frames below. */
export const RUNNER_PROTOCOL_VERSION = 1

/** JSON-RPC application error codes used by the runner protocol. */
export const RunnerTransportErrorCodes = {
  /** Command is part of the contract but not implemented by this peer. */
  unimplemented: -32001,
  /** Join token / api key rejected, or method used before authentication. */
  unauthorized: -32002,
  /** Runner and hub speak incompatible protocol versions. */
  protocolMismatch: -32003,
  /** Addressed runner is not connected to this hub. */
  unknownRunner: -32004
} as const

// ---------------------------------------------------------------------------
// runner → hub requests
// ---------------------------------------------------------------------------

export const RunnerToHubMethods = {
  enroll: 'enroll',
  hello: 'hello',
  heartbeat: 'heartbeat'
} as const

/**
 * Identifies one runner PROCESS INCARNATION. Minted once at runner startup,
 * unchanged across every reconnect that process makes, and different after any
 * restart.
 *
 * This is what makes "the socket dropped" distinguishable from "the runner
 * died" without guessing: reconnecting with the SAME epoch proves the process
 * that owns the pty sessions never went away, so the hub may reattach to them.
 * A different epoch proves the opposite — everything the old process held is
 * gone, and its sessions can be reaped immediately instead of waiting out a
 * lease.
 *
 * OPTIONAL on the wire: a runner too old to send one leaves the hub unable to
 * prove either, so it falls back to the conservative pre-epoch behavior
 * (finalize on disconnect). Fail closed, never reattach on an unproven identity.
 */
const epochField = z.string().min(1).optional()

/** First-contact authentication: exchange a join token for credentials. */
export const enrollParamsSchema = z.object({
  joinToken: z.string().min(1),
  /** Human-readable runner name (e.g. hostname). */
  name: z.string().min(1),
  /** `${process.platform}-${process.arch}`, e.g. `darwin-arm64`. */
  platform: z.string().min(1),
  /** Runner app version. */
  version: z.string().min(1),
  /** Capability tags, e.g. `['pty', 'git']`. */
  capabilities: z.array(z.string()),
  protocolVersion: z.number().int().positive(),
  epoch: epochField
})
export type EnrollParams = z.infer<typeof enrollParamsSchema>

export const enrollResultSchema = z.object({
  runnerId: z.string().min(1),
  apiKey: z.string().min(1)
})
export type EnrollResult = z.infer<typeof enrollResultSchema>

/** Reconnect authentication with previously minted credentials. */
export const helloParamsSchema = z.object({
  apiKey: z.string().min(1),
  epoch: epochField
})
export type HelloParams = z.infer<typeof helloParamsSchema>

export const helloResultSchema = z.object({
  runnerId: z.string().min(1)
})
export type HelloResult = z.infer<typeof helloResultSchema>

/** Liveness probe; also lets the runner detect an unresponsive hub. */
export const heartbeatParamsSchema = z.object({
  /** Sender wall-clock ms, for skew diagnostics. */
  ts: z.number().optional()
})
export type HeartbeatParams = z.infer<typeof heartbeatParamsSchema>

export const heartbeatResultSchema = z.object({
  ts: z.number()
})
export type HeartbeatResult = z.infer<typeof heartbeatResultSchema>

// ---------------------------------------------------------------------------
// runner → hub notifications
// ---------------------------------------------------------------------------

export const RunnerNotificationMethods = {
  ptyData: 'pty.data',
  ptyExit: 'pty.exit',
  procData: 'proc.data',
  procExit: 'proc.exit',
  event: 'event',
  checkoutStatus: 'checkout.status'
} as const

export const ptyDataParamsSchema = z.object({
  sessionId: z.string().min(1),
  /** Monotonic per-session sequence number, preserved end-to-end. */
  seq: z.number().int().nonnegative(),
  data: z.string()
})
export type PtyDataParams = z.infer<typeof ptyDataParamsSchema>

export const ptyExitParamsSchema = z.object({
  sessionId: z.string().min(1),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable().optional()
})
export type PtyExitParams = z.infer<typeof ptyExitParamsSchema>

/** Generic runner-side event (agent lifecycle, diagnostics, …). */
export const runnerEventParamsSchema = z.object({
  name: z.string().min(1),
  payload: z.unknown().optional()
})
export type RunnerEventParams = z.infer<typeof runnerEventParamsSchema>

/**
 * `RunnerEventParams.name` for a relayed agent lifecycle hook. A runner-routed
 * pty posts its hook to the runner's OWN loopback `/api/agent-hook`, and the
 * runner forwards the raw envelope to the hub as a generic `event` with THIS
 * name. Shared wire contract: the runner emits it, the hub matches on it.
 */
export const AGENT_HOOK_EVENT_NAME = 'agent-hook'

/** Progress of a workspace checkout/clone on the runner. */
export const checkoutStatusParamsSchema = z.object({
  checkoutId: z.string().min(1),
  status: z.string().min(1),
  detail: z.unknown().optional()
})
export type CheckoutStatusParams = z.infer<typeof checkoutStatusParamsSchema>

/**
 * Child-process output chunk (proc.spawn stream).
 *
 * SEQUENCED, like `pty.data`: `seq` is a per-session monotonic counter assigned
 * by the runner at emission, and the hub detects gaps + replays them via
 * `proc.getBufferSince`. This is not symmetry for its own sake — a chat agent's
 * stdout is an NDJSON protocol stream, so a single dropped or reordered chunk
 * desynchronizes the driver's request correlation irrecoverably (a torn line is
 * not recoverable by the reader). `stream` distinguishes stdout from stderr;
 * absent means stdout. Only the stdout stream is buffered/replayable — stderr is
 * diagnostic and delivered in arrival order.
 */
export const procDataParamsSchema = z.object({
  sessionId: z.string().min(1),
  /** Monotonic per-session sequence number for `stdout`. Absent on stderr. */
  seq: z.number().int().nonnegative().optional(),
  data: z.string(),
  stream: z.enum(['stdout', 'stderr']).optional()
})
export type ProcDataParams = z.infer<typeof procDataParamsSchema>

/** Child process exited. Mirrors `pty.exit`. */
export const procExitParamsSchema = z.object({
  sessionId: z.string().min(1),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable().optional()
})
export type ProcExitParams = z.infer<typeof procExitParamsSchema>

export const runnerNotificationSchemas = {
  [RunnerNotificationMethods.ptyData]: ptyDataParamsSchema,
  [RunnerNotificationMethods.ptyExit]: ptyExitParamsSchema,
  [RunnerNotificationMethods.procData]: procDataParamsSchema,
  [RunnerNotificationMethods.procExit]: procExitParamsSchema,
  [RunnerNotificationMethods.event]: runnerEventParamsSchema,
  [RunnerNotificationMethods.checkoutStatus]: checkoutStatusParamsSchema
} as const
export type RunnerNotificationMethod = keyof typeof runnerNotificationSchemas

// ---------------------------------------------------------------------------
// hub → runner requests
// ---------------------------------------------------------------------------

export const HubToRunnerMethods = {
  ptySpawn: 'pty.spawn',
  ptyKill: 'pty.kill',
  ptyResize: 'pty.resize',
  ptyWrite: 'pty.write',
  ptyGetBufferSince: 'pty.getBufferSince',
  /** Live (non-warm) sessions the runner still holds — drives reattach. */
  ptyList: 'pty.list',
  // warm pool (pre-warmed agents live ON the runner — see server/warm-*)
  ptyWarmSpawn: 'pty.warmSpawn',
  ptyWarmAdopt: 'pty.warmAdopt',
  ptyWarmKill: 'pty.warmKill',
  ptyWarmList: 'pty.warmList',
  // git ops (routed WorktreeExecAdapters — see server/exec-proxies)
  gitIsGitRepo: 'git.isGitRepo',
  gitGetCurrentBranch: 'git.getCurrentBranch',
  gitCreateWorktree: 'git.createWorktree',
  gitRemoveWorktree: 'git.removeWorktree',
  gitRunWorktreeSetupScript: 'git.runWorktreeSetupScript',
  gitCopyIgnoredFiles: 'git.copyIgnoredFiles',
  // raw-fs ops (routed pathExists / removeArtifactDir seams)
  fsPathExists: 'fs.pathExists',
  fsRemoveDir: 'fs.removeDir',
  // child-process ops (routed ProcessBackend + routed chat agents)
  procSpawn: 'proc.spawn',
  procKill: 'proc.kill',
  procWrite: 'proc.write',
  procGetBufferSince: 'proc.getBufferSince',
  /** Live child processes the runner still holds — drives reattach. */
  procList: 'proc.list',
  ping: 'ping',
  runnerShutdown: 'runner.shutdown'
} as const

/** Reserved method namespaces for future hub → runner exec commands. */
export const RESERVED_HUB_METHOD_PREFIXES = ['pty.', 'fs.', 'git.', 'proc.'] as const

export const ptySpawnParamsSchema = z.object({
  sessionId: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional()
})
export type PtySpawnParams = z.infer<typeof ptySpawnParamsSchema>

export const ptySpawnResultSchema = z.object({
  pid: z.number().int()
})
export type PtySpawnResult = z.infer<typeof ptySpawnResultSchema>

export const ptyKillParamsSchema = z.object({
  sessionId: z.string().min(1),
  signal: z.string().optional()
})
export type PtyKillParams = z.infer<typeof ptyKillParamsSchema>

export const ptyResizeParamsSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive()
})
export type PtyResizeParams = z.infer<typeof ptyResizeParamsSchema>

export const ptyWriteParamsSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string()
})
export type PtyWriteParams = z.infer<typeof ptyWriteParamsSchema>

/** Replay buffered output with `seq > since.seq` (gap recovery on reconnect). */
export const ptyGetBufferSinceParamsSchema = z.object({
  sessionId: z.string().min(1),
  /**
   * Exclusive lower bound — frames with `seq > this` are replayed.
   *
   * MAY be -1, meaning "everything, including seq 0". The hub's gap detector
   * starts at `lastSeq = -1` (`exec-proxies.ts`) precisely so seq 0 is not eaten,
   * and it sends that value verbatim when the OPENING chunk is the one that went
   * missing. A `nonnegative()` bound here rejected exactly that request; the
   * rejection was swallowed by the caller's best-effort catch, so the session
   * silently lost its first output instead of recovering it — the very bug
   * starting at -1 exists to prevent. `procGetBufferSinceParamsSchema` already
   * allows it; these two must not drift.
   */
  seq: z.number().int()
})
export type PtyGetBufferSinceParams = z.infer<typeof ptyGetBufferSinceParamsSchema>

export const ptyGetBufferSinceResultSchema = z.object({
  frames: z.array(
    z.object({
      seq: z.number().int().nonnegative(),
      data: z.string()
    })
  )
})
export type PtyGetBufferSinceResult = z.infer<typeof ptyGetBufferSinceResultSchema>

/**
 * Live (non-warm) sessions the runner still holds. The runner is the AUTHORITY
 * on this — the hub's own registry is only a belief about it, and after a
 * dropped connection the two can disagree in both directions.
 *
 * `seq` is the highest seq the runner has assigned, so the hub can tell whether
 * it missed anything while detached and backfill via `pty.getBufferSince`.
 * Empty on a runner holding nothing, which is a legitimate answer, NOT an error:
 * it means every session really did exit while the hub was away.
 */
export const ptyListResultSchema = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string().min(1),
      pid: z.number().int(),
      /** Highest assigned seq; -1 when the session has emitted nothing yet. */
      seq: z.number().int()
    })
  )
})
export type PtyListResult = z.infer<typeof ptyListResultSchema>

// ---------------------------------------------------------------------------
// hub → runner requests: warm pool
//
// A pre-warmed agent is an ORDINARY pty session on the runner, keyed by a
// `warmId` instead of a real `sessionId`. Adoption REKEYS that entry rather than
// spawning anything: the process, its pid and — critically — its RingBuffer and
// assigned seqs all carry over untouched, so `pty.getBufferSince` stays coherent
// across the adopt boundary. Replaying a seed into a fresh buffer instead would
// restart seq numbering under a stream the hub is already tracking.
//
// The runner owns the process; the hub owns the POLICY (which projects deserve a
// warm agent) and the `agent_sessions` rows. That split is why there is no
// "warm state" frame — the hub already knows what it asked for.
// ---------------------------------------------------------------------------

export const ptyWarmSpawnParamsSchema = z.object({
  /** Placeholder session key; becomes a real `sessionId` at adopt. */
  warmId: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  /**
   * Written to the shell's stdin right after spawn, to `exec` the agent inside
   * it (the pre-boot). Optional: omitted ⇒ a bare warm shell, and the caller
   * execs at adopt instead.
   */
  postSpawnCommand: z.string().optional()
})
export type PtyWarmSpawnParams = z.infer<typeof ptyWarmSpawnParamsSchema>

export const ptyWarmSpawnResultSchema = z.object({
  pid: z.number().int()
})
export type PtyWarmSpawnResult = z.infer<typeof ptyWarmSpawnResultSchema>

/** Promote a warm session to a real one. Rekeys in place — no respawn. */
export const ptyWarmAdoptParamsSchema = z.object({
  warmId: z.string().min(1),
  sessionId: z.string().min(1)
})
export type PtyWarmAdoptParams = z.infer<typeof ptyWarmAdoptParamsSchema>

export const ptyWarmAdoptResultSchema = z.object({
  pid: z.number().int(),
  /**
   * Everything the warm process emitted before adoption, and the seq it stopped
   * at. The hub seeds its own buffer with `data` and resumes gap detection from
   * `seq`, so the first post-adopt frame is contiguous with the pre-adopt ones.
   */
  data: z.string(),
  seq: z.number().int()
})
export type PtyWarmAdoptResult = z.infer<typeof ptyWarmAdoptResultSchema>

export const ptyWarmKillParamsSchema = z.object({
  warmId: z.string().min(1)
})
export type PtyWarmKillParams = z.infer<typeof ptyWarmKillParamsSchema>

/**
 * Every warm session this runner still holds.
 *
 * Load-bearing on reconnect: warm agents are the runner's processes, so unlike
 * the old hub-local pool they SURVIVE a hub restart — and an unclaimed pre-booted
 * agent is a billable process with no owner. The hub reconciles against this list
 * when a runner (re)connects and kills what it no longer wants.
 */
export const ptyWarmListResultSchema = z.object({
  warms: z.array(
    z.object({
      warmId: z.string().min(1),
      cwd: z.string(),
      pid: z.number().int(),
      startedAt: z.number()
    })
  )
})
export type PtyWarmListResult = z.infer<typeof ptyWarmListResultSchema>

export const pingParamsSchema = z.object({
  ts: z.number().optional()
})
export type PingParams = z.infer<typeof pingParamsSchema>

export const pingResultSchema = z.object({
  ts: z.number()
})
export type PingResult = z.infer<typeof pingResultSchema>

export const runnerShutdownParamsSchema = z.object({
  reason: z.string().optional(),
  /** Grace period before the runner may hard-exit. */
  deadlineMs: z.number().int().nonnegative().optional()
})
export type RunnerShutdownParams = z.infer<typeof runnerShutdownParamsSchema>

// ---------------------------------------------------------------------------
// hub → runner requests: git ops
//
// Param/result shapes mirror the task-domain `WorktreeExecAdapters` seam
// (narrowed to the arguments task ops actually pass); the hub-side routing
// adapters in `server/exec-proxies` forward each seam method to these frames.
// ---------------------------------------------------------------------------

export const gitIsGitRepoParamsSchema = z.object({
  path: z.string().min(1)
})
export type GitIsGitRepoParams = z.infer<typeof gitIsGitRepoParamsSchema>

export const gitIsGitRepoResultSchema = z.object({
  isGitRepo: z.boolean()
})
export type GitIsGitRepoResult = z.infer<typeof gitIsGitRepoResultSchema>

export const gitGetCurrentBranchParamsSchema = z.object({
  repoPath: z.string().min(1)
})
export type GitGetCurrentBranchParams = z.infer<typeof gitGetCurrentBranchParamsSchema>

export const gitGetCurrentBranchResultSchema = z.object({
  branch: z.string().nullable()
})
export type GitGetCurrentBranchResult = z.infer<typeof gitGetCurrentBranchResultSchema>

export const gitCreateWorktreeParamsSchema = z.object({
  repoPath: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  sourceBranch: z.string().optional()
})
export type GitCreateWorktreeParams = z.infer<typeof gitCreateWorktreeParamsSchema>

export const gitRemoveWorktreeParamsSchema = z.object({
  projectPath: z.string().min(1),
  worktreePath: z.string().min(1)
})
export type GitRemoveWorktreeParams = z.infer<typeof gitRemoveWorktreeParamsSchema>

export const gitRemoveWorktreeResultSchema = z.object({
  branchDeleted: z.boolean().optional(),
  branchError: z.string().optional()
})
export type GitRemoveWorktreeResult = z.infer<typeof gitRemoveWorktreeResultSchema>

export const gitRunWorktreeSetupScriptParamsSchema = z.object({
  worktreePath: z.string().min(1),
  repoPath: z.string().min(1),
  sourceBranch: z.string().nullable().optional()
})
export type GitRunWorktreeSetupScriptParams = z.infer<typeof gitRunWorktreeSetupScriptParamsSchema>

export const gitRunWorktreeSetupScriptResultSchema = z.object({
  ran: z.boolean(),
  success: z.boolean().optional(),
  output: z.string().optional()
})
export type GitRunWorktreeSetupScriptResult = z.infer<typeof gitRunWorktreeSetupScriptResultSchema>

export const gitCopyIgnoredFilesParamsSchema = z.object({
  repoPath: z.string().min(1),
  worktreePath: z.string().min(1),
  behavior: z.enum(['all', 'custom']),
  customPaths: z.array(z.string())
})
export type GitCopyIgnoredFilesParams = z.infer<typeof gitCopyIgnoredFilesParamsSchema>

// ---------------------------------------------------------------------------
// hub → runner requests: raw-fs ops
// ---------------------------------------------------------------------------

export const fsPathExistsParamsSchema = z.object({
  path: z.string().min(1)
})
export type FsPathExistsParams = z.infer<typeof fsPathExistsParamsSchema>

export const fsPathExistsResultSchema = z.object({
  exists: z.boolean()
})
export type FsPathExistsResult = z.infer<typeof fsPathExistsResultSchema>

export const fsRemoveDirParamsSchema = z.object({
  path: z.string().min(1)
})
export type FsRemoveDirParams = z.infer<typeof fsRemoveDirParamsSchema>

// ---------------------------------------------------------------------------
// hub → runner requests: child-process ops
// ---------------------------------------------------------------------------

export const procSpawnParamsSchema = z.object({
  sessionId: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  /**
   * Run `command` through the RUNNER's own login shell (its `$SHELL`) instead of
   * spawning it as a literal file+argv. Set by the process domain, whose
   * `command` is a shell string (`pnpm dev`); NOT set for an agent spawn, which
   * passes a resolved binary + argv that a shell would re-parse (splitting any
   * arg containing spaces).
   *
   * The shell is resolved runner-side deliberately: the hub's `$SHELL` is a path
   * that need not exist on the runner's machine.
   */
  shell: z.boolean().optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional()
})
export type ProcSpawnParams = z.infer<typeof procSpawnParamsSchema>

export const procSpawnResultSchema = z.object({
  /** `null` when the OS never assigned one (immediate spawn failure). The runner
   *  reports `child.pid ?? null`, so a non-nullable int here rejected that reply —
   *  the hub then treated a legitimately-failed spawn as a protocol error. */
  pid: z.number().int().nullable()
})
export type ProcSpawnResult = z.infer<typeof procSpawnResultSchema>

export const procKillParamsSchema = z.object({
  sessionId: z.string().min(1),
  signal: z.string().optional()
})
export type ProcKillParams = z.infer<typeof procKillParamsSchema>

/** Write to a routed child's stdin. Mirrors `pty.write`; this is what makes the
 *  channel duplex, and it is what a JSON-RPC/NDJSON chat agent requires. */
export const procWriteParamsSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string()
})
export type ProcWriteParams = z.infer<typeof procWriteParamsSchema>

/** Replay buffered stdout with `seq > since.seq` (gap recovery). Mirrors
 *  `pty.getBufferSince`. */
export const procGetBufferSinceParamsSchema = z.object({
  sessionId: z.string().min(1),
  seq: z.number().int()
})
export type ProcGetBufferSinceParams = z.infer<typeof procGetBufferSinceParamsSchema>

export const procGetBufferSinceResultSchema = z.object({
  frames: z.array(
    z.object({
      seq: z.number().int().nonnegative(),
      data: z.string()
    })
  )
})
export type ProcGetBufferSinceResult = z.infer<typeof procGetBufferSinceResultSchema>

/**
 * Live child processes the runner still holds. The `proc.list` twin of
 * {@link ptyListResultSchema} — same role in reattach, and the two must not
 * drift.
 */
export const procListResultSchema = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string().min(1),
      pid: z.number().int().optional(),
      /** Highest assigned seq; -1 when nothing has been emitted yet. */
      seq: z.number().int()
    })
  )
})
export type ProcListResult = z.infer<typeof procListResultSchema>
