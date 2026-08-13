/**
 * Computer wire contract — zod schemas for every frame exchanged between a hub
 * and its computers over the duplex JSON-RPC channel.
 *
 * Versioning: the contract is versioned via `protocolVersion` carried in the
 * `enroll` request. A hub rejects enrollment from a computer speaking a
 * different major protocol version with `ComputerTransportErrorCodes.protocolMismatch`.
 * Reconnects (`hello`) reuse credentials minted at enroll time, so the
 * version negotiated at enrollment governs the session.
 *
 * Direction map (v1):
 *  computer → hub requests:      enroll, hello, heartbeat
 *  computer → hub notifications: pty.data, pty.exit, proc.data, proc.exit,
 *                              event, fs.change
 *  hub → computer requests:      pty.spawn, pty.kill, pty.resize, pty.write,
 *                              pty.getBufferSince, git.isGitRepo,
 *                              git.getCurrentBranch, git.createWorktree,
 *                              git.removeWorktree, git.runWorktreeSetupScript,
 *                              git.copyIgnoredFiles, fs.* (see below),
 *                              proc.spawn, proc.kill, ping, computer.shutdown
 *
 * The `fs.` namespace has three groups, kept distinct on purpose:
 *   - raw probes    — fs.pathExists, fs.removeDir
 *   - workspace browse (ABSOLUTE paths, jail-scoped) — fs.listRoots, fs.listDir,
 *     fs.mkdir. Back the desktop's directory picker, which must describe the
 *     computer's disk before a project root exists.
 *   - file editor (ROOT-SCOPED, gitignore-aware) — fs.readDir, fs.readFile,
 *     fs.writeFile, fs.createFile, fs.createDir, fs.rename, fs.delete,
 *     fs.copyIn, fs.copy, fs.gitStatus, fs.searchFiles, fs.listAllFiles,
 *     fs.watchStart, fs.watchStop.
 *
 * `pty.data.seq` is a per-session monotonic sequence number assigned by the
 * computer at emission and preserved end-to-end, so the hub can detect gaps and
 * request replay via `pty.getBufferSince`.
 *
 * @module computer/shared/frames
 */

import { z } from 'zod'

/**
 * Computer process exit code meaning "the hub no longer recognizes this computer".
 *
 * 78 = EX_CONFIG (sysexits.h): a configuration problem a restart cannot fix. A
 * supervisor must NOT respawn on this — the hub has lost this computer's identity
 * (storage deleted, one of its two DBs restored without the other, or the computer
 * revoked) and only an operator enrolling it again resolves it. Lives here so the
 * computer that exits with it and the supervisor that reads it cannot disagree.
 */
export const COMPUTER_EXIT_NEEDS_RE_ENROLLMENT = 78

/** Bump on any breaking change to the frames below. */
export const COMPUTER_PROTOCOL_VERSION = 2

/** JSON-RPC application error codes used by the computer protocol. */
export const ComputerTransportErrorCodes = {
  /** Command is part of the contract but not implemented by this peer. */
  unimplemented: -32001,
  /** Join token / api key rejected, or method used before authentication. */
  unauthorized: -32002,
  /** Computer and hub speak incompatible protocol versions. */
  protocolMismatch: -32003,
  /** Addressed computer is not connected to this hub. */
  unknownComputer: -32004
} as const

// ---------------------------------------------------------------------------
// computer → hub requests
// ---------------------------------------------------------------------------

export const ComputerToHubMethods = {
  enroll: 'enroll',
  hello: 'hello',
  heartbeat: 'heartbeat'
} as const

/**
 * Identifies one computer PROCESS INCARNATION. Minted once at computer startup,
 * unchanged across every reconnect that process makes, and different after any
 * restart.
 *
 * This is what makes "the socket dropped" distinguishable from "the computer
 * died" without guessing: reconnecting with the SAME epoch proves the process
 * that owns the pty sessions never went away, so the hub may reattach to them.
 * A different epoch proves the opposite — everything the old process held is
 * gone, and its sessions can be reaped immediately instead of waiting out a
 * lease.
 *
 * OPTIONAL on the wire: a computer too old to send one leaves the hub unable to
 * prove either, so it falls back to the conservative pre-epoch behavior
 * (finalize on disconnect). Fail closed, never reattach on an unproven identity.
 */
const epochField = z.string().min(1).optional()

/**
 * Which physical box this computer is on — see `computer/host-id.ts`.
 *
 * OPTIONAL on purpose: a computer too old to report one stays UNGROUPED rather
 * than being guessed onto a machine. Grouping is cosmetic, so absent must mean
 * "unknown", never "same as some other box".
 */
const hostIdField = z.string().min(1).optional()

/** First-contact authentication: exchange a join token for credentials. */
export const enrollParamsSchema = z.object({
  joinToken: z.string().min(1),
  /** Human-readable computer name (e.g. hostname). */
  name: z.string().min(1),
  /** `${process.platform}-${process.arch}`, e.g. `darwin-arm64`. */
  platform: z.string().min(1),
  /** Computer app version. */
  version: z.string().min(1),
  /** Capability tags, e.g. `['pty', 'git']`. */
  capabilities: z.array(z.string()),
  protocolVersion: z.number().int().positive(),
  epoch: epochField,
  hostId: hostIdField
})
export type EnrollParams = z.infer<typeof enrollParamsSchema>

export const enrollResultSchema = z.object({
  computerId: z.string().min(1),
  apiKey: z.string().min(1)
})
export type EnrollResult = z.infer<typeof enrollResultSchema>

/** Reconnect authentication with previously minted credentials. */
export const helloParamsSchema = z.object({
  apiKey: z.string().min(1),
  epoch: epochField,
  hostId: hostIdField
})
export type HelloParams = z.infer<typeof helloParamsSchema>

export const helloResultSchema = z.object({
  computerId: z.string().min(1)
})
export type HelloResult = z.infer<typeof helloResultSchema>

/** Liveness probe; also lets the computer detect an unresponsive hub. */
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
// computer → hub notifications
// ---------------------------------------------------------------------------

export const ComputerNotificationMethods = {
  ptyData: 'pty.data',
  ptyExit: 'pty.exit',
  procData: 'proc.data',
  procExit: 'proc.exit',
  event: 'event',
  fsChange: 'fs.change'
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

/** Generic computer-side event (agent lifecycle, diagnostics, …). */
export const computerEventParamsSchema = z.object({
  name: z.string().min(1),
  payload: z.unknown().optional()
})
export type ComputerEventParams = z.infer<typeof computerEventParamsSchema>

/**
 * `ComputerEventParams.name` for a relayed agent lifecycle hook. A computer-routed
 * pty posts its hook to the computer's OWN loopback `/api/agent-hook`, and the
 * computer forwards the raw envelope to the hub as a generic `event` with THIS
 * name. Shared wire contract: the computer emits it, the hub matches on it.
 */
export const AGENT_HOOK_EVENT_NAME = 'agent-hook'

/**
 * Child-process output chunk (proc.spawn stream).
 *
 * SEQUENCED, like `pty.data`: `seq` is a per-session monotonic counter assigned
 * by the computer at emission, and the hub detects gaps + replays them via
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

/**
 * A watched file changed on the computer (file-editor panel).
 *
 * Correlated by `watchId`, which the HUB mints and passes to `fs.watchStart` —
 * not by `rootPath`. Two tasks can watch the same root on the same computer, and a
 * root-keyed stream could not tell their subscriptions apart on unsubscribe.
 * `relPath` is relative to the watched root, matching `FileWatchEvent` in
 * `@slayzone/file-editor/server`, which is what produces these events.
 */
export const fsChangeParamsSchema = z.object({
  watchId: z.string().min(1),
  type: z.enum(['changed', 'deleted']),
  relPath: z.string()
})
export type FsChangeParams = z.infer<typeof fsChangeParamsSchema>

export const computerNotificationSchemas = {
  [ComputerNotificationMethods.ptyData]: ptyDataParamsSchema,
  [ComputerNotificationMethods.ptyExit]: ptyExitParamsSchema,
  [ComputerNotificationMethods.procData]: procDataParamsSchema,
  [ComputerNotificationMethods.procExit]: procExitParamsSchema,
  [ComputerNotificationMethods.event]: computerEventParamsSchema,
  [ComputerNotificationMethods.fsChange]: fsChangeParamsSchema
} as const
export type ComputerNotificationMethod = keyof typeof computerNotificationSchemas

// ---------------------------------------------------------------------------
// hub → computer requests
// ---------------------------------------------------------------------------

export const HubToComputerMethods = {
  ptySpawn: 'pty.spawn',
  ptyKill: 'pty.kill',
  ptyResize: 'pty.resize',
  ptyWrite: 'pty.write',
  ptyGetBufferSince: 'pty.getBufferSince',
  /** Live (non-warm) sessions the computer still holds — drives reattach. */
  ptyList: 'pty.list',
  // warm pool (pre-warmed agents live ON the computer — see server/warm-*)
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
  // workspace browse ops — ABSOLUTE paths inside the computer's allowedRoots, used
  // by the desktop's directory picker before any project/root exists.
  fsListRoots: 'fs.listRoots',
  fsListDir: 'fs.listDir',
  fsMkdir: 'fs.mkdir',
  // file-editor ops — ROOT-SCOPED (rootPath + a path relative to it), gitignore
  // aware. One-to-one with `@slayzone/file-editor/server`, which the computer
  // imports directly rather than reimplementing.
  fsReadDir: 'fs.readDir',
  fsReadFile: 'fs.readFile',
  fsWriteFile: 'fs.writeFile',
  fsCreateFile: 'fs.createFile',
  fsCreateDir: 'fs.createDir',
  fsRename: 'fs.rename',
  fsDelete: 'fs.delete',
  fsCopyIn: 'fs.copyIn',
  fsCopy: 'fs.copy',
  fsGitStatus: 'fs.gitStatus',
  fsSearchFiles: 'fs.searchFiles',
  fsListAllFiles: 'fs.listAllFiles',
  /** Whole-tree git repo discovery — one call, not one per directory. */
  fsDiscoverRepos: 'fs.discoverRepos',
  // file-editor watch lifecycle; changes stream back as `fs.change` notifications.
  fsWatchStart: 'fs.watchStart',
  fsWatchStop: 'fs.watchStop',
  // child-process ops (routed ProcessBackend + routed chat agents)
  procSpawn: 'proc.spawn',
  procKill: 'proc.kill',
  procWrite: 'proc.write',
  procGetBufferSince: 'proc.getBufferSince',
  /** Live child processes the computer still holds — drives reattach. */
  procList: 'proc.list',
  // project → path mapping. The COMPUTER owns where a project lives on its own
  // disk; the hub knows only which computer. See `project.resolvePath` below.
  projectResolvePath: 'project.resolvePath',
  projectSetPath: 'project.setPath',
  projectForgetPath: 'project.forgetPath',
  projectList: 'project.list',
  ping: 'ping',
  computerShutdown: 'computer.shutdown',
  /** Edit the computer's own path-jail (Settings → Computers). */
  computerSetAllowedRoots: 'computer.setAllowedRoots',
  /** Run `gh` on the computer (PR panel). One frame, not one per gh subcommand. */
  ghExec: 'gh.exec'
} as const

/** Reserved method namespaces for future hub → computer exec commands. */
export const RESERVED_HUB_METHOD_PREFIXES = ['pty.', 'fs.', 'git.', 'proc.', 'project.'] as const

export const ptySpawnParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    /**
     * Absolute cwd. Optional now: when absent the COMPUTER resolves it from
     * `projectId` against its own `project.*` mapping, because the hub cannot —
     * it held one path column naming a directory on a machine it does not own.
     *
     * Still sent, and authoritative when it is, for the two cases where the path
     * is not a hub guess: a worktree the computer itself created, and an explicit
     * `task.base_dir` override.
     */
    cwd: z.string().min(1).optional(),
    /** Lets the computer resolve its own cwd when `cwd` is absent. */
    projectId: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional()
  })
  // Neither one means a spawn with nowhere to run. Refuse at the schema rather
  // than landing an agent in the computer's launch directory, which is the kind of
  // silent wrong-cwd this whole change exists to remove.
  .refine((p) => p.cwd !== undefined || p.projectId !== undefined, {
    message: 'pty.spawn needs either cwd or projectId'
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
 * Live (non-warm) sessions the computer still holds. The computer is the AUTHORITY
 * on this — the hub's own registry is only a belief about it, and after a
 * dropped connection the two can disagree in both directions.
 *
 * `seq` is the highest seq the computer has assigned, so the hub can tell whether
 * it missed anything while detached and backfill via `pty.getBufferSince`.
 * Empty on a computer holding nothing, which is a legitimate answer, NOT an error:
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
// hub → computer requests: warm pool
//
// A pre-warmed agent is an ORDINARY pty session on the computer, keyed by a
// `warmId` instead of a real `sessionId`. Adoption REKEYS that entry rather than
// spawning anything: the process, its pid and — critically — its RingBuffer and
// assigned seqs all carry over untouched, so `pty.getBufferSince` stays coherent
// across the adopt boundary. Replaying a seed into a fresh buffer instead would
// restart seq numbering under a stream the hub is already tracking.
//
// The computer owns the process; the hub owns the POLICY (which projects deserve a
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
 * Every warm session this computer still holds.
 *
 * Load-bearing on reconnect: warm agents are the computer's processes, so unlike
 * the old hub-local pool they SURVIVE a hub restart — and an unclaimed pre-booted
 * agent is a billable process with no owner. The hub reconciles against this list
 * when a computer (re)connects and kills what it no longer wants.
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

/**
 * Replace the computer's `allowedRoots` path-jail, persisting to its
 * `computer.config.json` and applying without a restart.
 *
 * Not a privilege grant: a hub that can `pty.spawn` already runs arbitrary
 * commands on the computer, so the jail is a safety rail against a mistaken path,
 * not a security boundary against the hub. It exists so a stale project path
 * cannot make the hub delete the wrong tree — which is exactly why the operator
 * needs to be able to widen it when their projects legitimately live elsewhere.
 */
export const computerSetAllowedRootsParamsSchema = z.object({
  /** Absolute paths. Replaces the current set wholesale. */
  roots: z.array(z.string().min(1))
})
export type ComputerSetAllowedRootsParams = z.infer<typeof computerSetAllowedRootsParamsSchema>

export const computerSetAllowedRootsResultSchema = z.object({
  /** The set actually applied, realpath-resolved and de-duplicated. */
  roots: z.array(z.string()),
  /** Requested roots that were dropped, with the reason (absent dir, relative). */
  rejected: z.array(z.object({ path: z.string(), reason: z.string() }))
})
export type ComputerSetAllowedRootsResult = z.infer<typeof computerSetAllowedRootsResultSchema>

// ---------------------------------------------------------------------------
// hub → computer requests: project → path mapping
//
// `projects.path` used to live on the hub: ONE column naming a directory the hub
// cannot see, on a machine it does not own. Two computers laying the same project
// out differently made the hub necessarily wrong about one of them, and a Windows
// computer does not even agree on the separator.
//
// So the hub knows WHAT a project is (id, name) and each computer knows WHERE it
// put that project. Every path is one the user pointed at: nothing here creates
// a checkout, so there is no second kind to distinguish.
// ---------------------------------------------------------------------------

export const projectResolvePathParamsSchema = z.object({
  projectId: z.string().min(1)
})
export type ProjectResolvePathParams = z.infer<typeof projectResolvePathParamsSchema>

/**
 * `path: null` = this computer has no checkout of that project.
 *
 * A real, actionable state — not an error. It is the honest answer the single
 * hub-side column could never give: it always had *a* path, even for a machine
 * that had never seen the project.
 */
export const projectResolvePathResultSchema = z.object({
  path: z.string().nullable(),
  /** False when the recorded path has since vanished from disk. */
  exists: z.boolean().optional()
})
export type ProjectResolvePathResult = z.infer<typeof projectResolvePathResultSchema>

export const projectSetPathParamsSchema = z.object({
  projectId: z.string().min(1),
  /** Absolute path ON THE COMPUTER. Must resolve inside `allowedRoots`. */
  path: z.string().min(1)
})
export type ProjectSetPathParams = z.infer<typeof projectSetPathParamsSchema>

export const projectSetPathResultSchema = z.object({
  /** The realpath-resolved path actually recorded. */
  path: z.string()
})
export type ProjectSetPathResult = z.infer<typeof projectSetPathResultSchema>

export const projectForgetPathParamsSchema = z.object({
  projectId: z.string().min(1)
})
export type ProjectForgetPathParams = z.infer<typeof projectForgetPathParamsSchema>

export const projectListParamsSchema = z.object({})
export type ProjectListParams = z.infer<typeof projectListParamsSchema>

export const projectListResultSchema = z.object({
  projects: z.array(
    z.object({
      projectId: z.string(),
      path: z.string(),
      exists: z.boolean()
    })
  )
})
export type ProjectListResult = z.infer<typeof projectListResultSchema>

/**
 * Run `gh` where the git work happens.
 *
 * ONE generic frame rather than one per subcommand. The hub already has a single
 * `spawnGh` chokepoint with eleven typed functions above it (`listOpenPrs`,
 * `createPr`, `getPrComments`, …); routing the chokepoint keeps that typing and
 * its parsing on the hub while the process runs on the computer. Eleven frames
 * would be eleven chances for the schema drift this contract has already paid
 * for four times.
 *
 * Why route it at all: `gh` authenticates as whoever owns the machine it runs on.
 * On the hub the PR panel spoke as the HUB while the agent pushed as the COMPUTER —
 * two identities for one repo, and only one of them had credentials.
 *
 * `args` is argv, never a shell string: a PR title or comment body is arbitrary
 * user text, and handing it to a shell would make quoting a security boundary.
 */
export const ghExecParamsSchema = z.object({
  args: z.array(z.string()),
  /** Repo directory. Passes the computer's allowedRoots jail. */
  cwd: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  /** Written to gh's stdin — used for a PR body, which can be long. */
  stdin: z.string().optional()
})
export type GhExecParams = z.infer<typeof ghExecParamsSchema>

export const ghExecResultSchema = z.object({
  /** Null when the process was killed by a signal or never started. */
  status: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string()
})
export type GhExecResult = z.infer<typeof ghExecResultSchema>

export const computerShutdownParamsSchema = z.object({
  reason: z.string().optional(),
  /** Grace period before the computer may hard-exit. */
  deadlineMs: z.number().int().nonnegative().optional()
})
export type ComputerShutdownParams = z.infer<typeof computerShutdownParamsSchema>

// ---------------------------------------------------------------------------
// hub → computer requests: git ops
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
// hub → computer requests: raw-fs ops
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
// hub → computer requests: workspace browse ops
//
// ABSOLUTE paths, scoped to the computer's `allowedRoots`. These back the desktop's
// directory picker, which has to answer "what is on the machine that will run the
// agent" BEFORE a project (and therefore a root) exists — so unlike the editor ops
// below they take no rootPath and return no relative paths.
// ---------------------------------------------------------------------------

/** No params: a computer's browsable roots are its configured path-jail. */
export const fsListRootsParamsSchema = z.object({})
export type FsListRootsParams = z.infer<typeof fsListRootsParamsSchema>

export const fsListRootsResultSchema = z.object({
  /** The computer's `allowedRoots`, realpath-resolved. Empty = fs access refused. */
  roots: z.array(z.string()),
  /** The computer user's home dir, for a sensible default expansion. */
  home: z.string().nullable(),
  /** `process.platform` — lets the client render paths in the computer's idiom. */
  platform: z.string(),
  /** Path separator on the computer, so the client never assumes POSIX. */
  sep: z.string()
})
export type FsListRootsResult = z.infer<typeof fsListRootsResultSchema>

export const fsListDirEntrySchema = z.object({
  name: z.string(),
  /** ABSOLUTE path on the computer. */
  path: z.string(),
  type: z.enum(['directory', 'file']),
  isSymlink: z.boolean().optional(),
  /** Directory contains a `.git` entry — surfaced so the picker can mark repos. */
  isGitRepo: z.boolean().optional()
})
export type FsListDirEntry = z.infer<typeof fsListDirEntrySchema>

export const fsListDirParamsSchema = z.object({
  /** Absolute dir to list. Must resolve inside an allowed root. */
  path: z.string().min(1),
  /** Omit files. The picker selects directories, so it passes true. */
  dirsOnly: z.boolean().optional(),
  /** Include dotfiles/dirs. Default false — a picker showing `.cache` is noise. */
  includeHidden: z.boolean().optional()
})
export type FsListDirParams = z.infer<typeof fsListDirParamsSchema>

export const fsListDirResultSchema = z.object({
  /** The realpath-resolved directory actually listed. */
  path: z.string(),
  /** Parent dir, or null when `path` IS an allowed root (nothing above it). */
  parent: z.string().nullable(),
  entries: z.array(fsListDirEntrySchema)
})
export type FsListDirResult = z.infer<typeof fsListDirResultSchema>

export const fsMkdirParamsSchema = z.object({
  /** Absolute path to create, recursively. Must land inside an allowed root. */
  path: z.string().min(1)
})
export type FsMkdirParams = z.infer<typeof fsMkdirParamsSchema>

export const fsMkdirResultSchema = z.object({
  /** The created directory, realpath-resolved. */
  path: z.string()
})
export type FsMkdirResult = z.infer<typeof fsMkdirResultSchema>

// ---------------------------------------------------------------------------
// hub → computer requests: file-editor ops
//
// ROOT-SCOPED: every path is relative to `rootPath`, gitignore is honoured, and
// the shapes are one-to-one with `@slayzone/file-editor/server`. The computer
// imports that module directly, so these schemas describe ITS types — the
// compile-time assertions in `computer/src/handlers/fs.ts` pin the two together.
//
// `rootPath` still passes the allowedRoots jail on the computer; `assertWithinRoot`
// inside file-editor then contains the relative part. Two independent guards,
// deliberately: the jail bounds the machine, the root bounds the workspace.
// ---------------------------------------------------------------------------

/** Mirrors `DirEntry` from `@slayzone/file-editor/shared`. */
export const fsDirEntrySchema = z.object({
  name: z.string(),
  /** Path RELATIVE to `rootPath`. */
  path: z.string(),
  type: z.enum(['file', 'directory']),
  ignored: z.boolean().optional(),
  isSymlink: z.boolean().optional()
})

export const fsReadDirParamsSchema = z.object({
  rootPath: z.string().min(1),
  dirPath: z.string()
})
export type FsReadDirParams = z.infer<typeof fsReadDirParamsSchema>

export const fsReadDirResultSchema = z.object({
  entries: z.array(fsDirEntrySchema)
})
export type FsReadDirResult = z.infer<typeof fsReadDirResultSchema>

export const fsReadFileParamsSchema = z.object({
  rootPath: z.string().min(1),
  filePath: z.string().min(1),
  force: z.boolean().optional()
})
export type FsReadFileParams = z.infer<typeof fsReadFileParamsSchema>

/** Mirrors `ReadFileResult`. `content: null` + `tooLarge` = refused by size. */
export const fsReadFileResultSchema = z.object({
  content: z.string().nullable(),
  tooLarge: z.boolean().optional(),
  sizeBytes: z.number().optional()
})
export type FsReadFileResult = z.infer<typeof fsReadFileResultSchema>

export const fsWriteFileParamsSchema = z.object({
  rootPath: z.string().min(1),
  filePath: z.string().min(1),
  content: z.string()
})
export type FsWriteFileParams = z.infer<typeof fsWriteFileParamsSchema>

export const fsCreateFileParamsSchema = z.object({
  rootPath: z.string().min(1),
  filePath: z.string().min(1)
})
export type FsCreateFileParams = z.infer<typeof fsCreateFileParamsSchema>

export const fsCreateDirParamsSchema = z.object({
  rootPath: z.string().min(1),
  dirPath: z.string().min(1)
})
export type FsCreateDirParams = z.infer<typeof fsCreateDirParamsSchema>

export const fsRenameParamsSchema = z.object({
  rootPath: z.string().min(1),
  oldPath: z.string().min(1),
  newPath: z.string().min(1)
})
export type FsRenameParams = z.infer<typeof fsRenameParamsSchema>

export const fsDeleteParamsSchema = z.object({
  rootPath: z.string().min(1),
  targetPath: z.string().min(1)
})
export type FsDeleteParams = z.infer<typeof fsDeleteParamsSchema>

export const fsCopyInParamsSchema = z.object({
  rootPath: z.string().min(1),
  /** Absolute source ON THE COMPUTER. Also jailed — it is a second machine path. */
  absoluteSrc: z.string().min(1),
  targetDir: z.string().optional()
})
export type FsCopyInParams = z.infer<typeof fsCopyInParamsSchema>

export const fsCopyInResultSchema = z.object({
  /** Path of the copy, relative to `rootPath`. */
  path: z.string()
})
export type FsCopyInResult = z.infer<typeof fsCopyInResultSchema>

export const fsCopyParamsSchema = z.object({
  rootPath: z.string().min(1),
  srcPath: z.string().min(1),
  destPath: z.string().min(1)
})
export type FsCopyParams = z.infer<typeof fsCopyParamsSchema>

export const fsGitStatusParamsSchema = z.object({
  rootPath: z.string().min(1)
})
export type FsGitStatusParams = z.infer<typeof fsGitStatusParamsSchema>

/** Mirrors `GitStatusMap`. */
export const fsGitStatusResultSchema = z.object({
  files: z.record(
    z.string(),
    z.enum(['modified', 'staged', 'untracked', 'added', 'deleted', 'renamed', 'conflicted'])
  ),
  isGitRepo: z.boolean()
})
export type FsGitStatusResult = z.infer<typeof fsGitStatusResultSchema>

/**
 * Transport-layer caps on the two whole-tree reads.
 *
 * These used to be in-process calls where returning 200k paths cost an array;
 * over the wire it is a single frame the hub must buffer, parse, and forward to
 * every subscribed client. Capping HERE rather than per-caller means one number
 * governs the wire, and `truncated` makes the cut visible instead of silently
 * presenting a partial tree as complete.
 */
export const FS_MAX_LIST_ALL_FILES = 50_000
export const FS_MAX_SEARCH_RESULTS = 2_000

export const fsListAllFilesParamsSchema = z.object({
  rootPath: z.string().min(1)
})
export type FsListAllFilesParams = z.infer<typeof fsListAllFilesParamsSchema>

export const fsListAllFilesResultSchema = z.object({
  /** Paths relative to `rootPath`, capped at {@link FS_MAX_LIST_ALL_FILES}. */
  files: z.array(z.string()),
  truncated: z.boolean()
})
export type FsListAllFilesResult = z.infer<typeof fsListAllFilesResultSchema>

export const fsSearchFilesParamsSchema = z.object({
  rootPath: z.string().min(1),
  query: z.string(),
  options: z
    .object({
      matchCase: z.boolean().optional(),
      regex: z.boolean().optional(),
      maxResults: z.number().int().positive().optional()
    })
    .optional()
})
export type FsSearchFilesParams = z.infer<typeof fsSearchFilesParamsSchema>

/** Mirrors `FileSearchResult[]`, capped at {@link FS_MAX_SEARCH_RESULTS}. */
export const fsSearchFilesResultSchema = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      matches: z.array(z.object({ line: z.number(), col: z.number(), lineText: z.string() }))
    })
  ),
  truncated: z.boolean()
})
export type FsSearchFilesResult = z.infer<typeof fsSearchFilesResultSchema>

export const fsDiscoverReposParamsSchema = z.object({
  rootPath: z.string().min(1),
  maxDepth: z.number().int().positive().optional()
})
export type FsDiscoverReposParams = z.infer<typeof fsDiscoverReposParamsSchema>

/** Mirrors `DiscoveredRepo[]` from `@slayzone/file-editor/server`. */
export const fsDiscoverReposResultSchema = z.object({
  repos: z.array(
    z.object({
      path: z.string(),
      name: z.string(),
      kind: z.enum(['project-root', 'child-repo', 'submodule']),
      parentPath: z.string().nullable(),
      hasGitmodules: z.boolean()
    })
  )
})
export type FsDiscoverReposResult = z.infer<typeof fsDiscoverReposResultSchema>

export const fsWatchStartParamsSchema = z.object({
  /** HUB-minted correlation id, echoed on every `fs.change` for this watch. */
  watchId: z.string().min(1),
  rootPath: z.string().min(1)
})
export type FsWatchStartParams = z.infer<typeof fsWatchStartParamsSchema>

export const fsWatchStopParamsSchema = z.object({
  watchId: z.string().min(1)
})
export type FsWatchStopParams = z.infer<typeof fsWatchStopParamsSchema>

/** Shared by the write/lifecycle fs ops that return nothing meaningful. */
export const fsOkResultSchema = z.object({ ok: z.literal(true) })
export type FsOkResult = z.infer<typeof fsOkResultSchema>

// ---------------------------------------------------------------------------
// hub → computer requests: child-process ops
// ---------------------------------------------------------------------------

export const procSpawnParamsSchema = z.object({
  sessionId: z.string().min(1),
  /** Resolve cwd from this project when `cwd` is absent. See `pty.spawn`. */
  projectId: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  /**
   * Run `command` through the COMPUTER's own login shell (its `$SHELL`) instead of
   * spawning it as a literal file+argv. Set by the process domain, whose
   * `command` is a shell string (`pnpm dev`); NOT set for an agent spawn, which
   * passes a resolved binary + argv that a shell would re-parse (splitting any
   * arg containing spaces).
   *
   * The shell is resolved computer-side deliberately: the hub's `$SHELL` is a path
   * that need not exist on the computer's machine.
   */
  shell: z.boolean().optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional()
})
export type ProcSpawnParams = z.infer<typeof procSpawnParamsSchema>

export const procSpawnResultSchema = z.object({
  /** `null` when the OS never assigned one (immediate spawn failure). The computer
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
 * Live child processes the computer still holds. The `proc.list` twin of
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
