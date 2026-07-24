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
  protocolVersion: z.number().int().positive()
})
export type EnrollParams = z.infer<typeof enrollParamsSchema>

export const enrollResultSchema = z.object({
  runnerId: z.string().min(1),
  apiKey: z.string().min(1)
})
export type EnrollResult = z.infer<typeof enrollResultSchema>

/** Reconnect authentication with previously minted credentials. */
export const helloParamsSchema = z.object({
  apiKey: z.string().min(1)
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
 * Child-process output chunk (proc.spawn stream). Unlike `pty.data`, process
 * output is not sequenced/replayable — there is no `proc.getBufferSince` — so
 * the hub delivers these in arrival order. `stream` distinguishes stdout from
 * stderr; absent means stdout.
 */
export const procDataParamsSchema = z.object({
  sessionId: z.string().min(1),
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
  // child-process ops (routed ProcessBackend)
  procSpawn: 'proc.spawn',
  procKill: 'proc.kill',
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
  seq: z.number().int().nonnegative()
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
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional()
})
export type ProcSpawnParams = z.infer<typeof procSpawnParamsSchema>

export const procSpawnResultSchema = z.object({
  pid: z.number().int()
})
export type ProcSpawnResult = z.infer<typeof procSpawnResultSchema>

export const procKillParamsSchema = z.object({
  sessionId: z.string().min(1),
  signal: z.string().optional()
})
export type ProcKillParams = z.infer<typeof procKillParamsSchema>
