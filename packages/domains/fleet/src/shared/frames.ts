/**
 * Fleet wire contract — zod schemas for every frame exchanged between a hub
 * and its runners over the duplex JSON-RPC channel.
 *
 * Versioning: the contract is versioned via `protocolVersion` carried in the
 * `enroll` request. A hub rejects enrollment from a runner speaking a
 * different major protocol version with `FleetErrorCodes.protocolMismatch`.
 * Reconnects (`hello`) reuse credentials minted at enroll time, so the
 * version negotiated at enrollment governs the session.
 *
 * Direction map (v1):
 *  runner → hub requests:      enroll, hello, heartbeat
 *  runner → hub notifications: pty.data, pty.exit, event, checkout.status
 *  hub → runner requests:      pty.spawn, pty.kill, pty.resize, pty.write,
 *                              pty.getBufferSince, fs.* (reserved),
 *                              git.* (reserved), ping, runner.shutdown
 *
 * `pty.data.seq` is a per-session monotonic sequence number assigned by the
 * runner at emission and preserved end-to-end, so the hub can detect gaps and
 * request replay via `pty.getBufferSince`.
 *
 * @module fleet/shared/frames
 */

import { z } from 'zod'

/** Bump on any breaking change to the frames below. */
export const FLEET_PROTOCOL_VERSION = 1

/** JSON-RPC application error codes used by the fleet protocol. */
export const FleetErrorCodes = {
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

/** Progress of a workspace checkout/clone on the runner. */
export const checkoutStatusParamsSchema = z.object({
  checkoutId: z.string().min(1),
  status: z.string().min(1),
  detail: z.unknown().optional()
})
export type CheckoutStatusParams = z.infer<typeof checkoutStatusParamsSchema>

export const runnerNotificationSchemas = {
  [RunnerNotificationMethods.ptyData]: ptyDataParamsSchema,
  [RunnerNotificationMethods.ptyExit]: ptyExitParamsSchema,
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
  ping: 'ping',
  runnerShutdown: 'runner.shutdown'
} as const

/** Reserved method namespaces for future hub → runner exec commands. */
export const RESERVED_HUB_METHOD_PREFIXES = ['pty.', 'fs.', 'git.'] as const

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
