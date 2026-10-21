/**
 * Security audit events: one JSON object per line on stdout.
 *
 * WHY STDOUT. A hub runs as a service whose stdout a log agent ships (journald →
 * Azure Monitor Agent → Log Analytics on the Normain VM; `docker logs` elsewhere).
 * A line-delimited JSON record needs no parser config there and survives being
 * interleaved with the hub's free-text banner lines. Filter on `"type":"security"`.
 * The verbose file log (`apps/hub/src/log.ts`) is separate and unchanged; the
 * desktop app pipes its own hub's stdout into its log line by line, unparsed.
 *
 *   {"type":"security","ts":"2026-10-21T09:12:03.120Z","level":"warn",
 *    "event":"auth.signin","outcome":"failure","actor":null,"ip":"10.93.1.4",
 *    "targetKind":null,"targetId":null,"route":"POST /api/auth/sign-in/email",
 *    "detail":{"method":"password","reason":"INVALID_EMAIL_OR_PASSWORD"}}
 *
 * Every field is always present (null when unknown) so a log query sees one shape.
 * `ip` is the TCP peer address: behind a front end that is the front end, until the
 * hub trusts its `X-Forwarded-For` (T-22).
 *
 * WHAT NEVER GOES IN A LINE: passwords, tokens, cookies, secrets, prompts, terminal
 * bytes, file content, email addresses. Callers pass ids and short codes; `detail`
 * is filtered here as a second line of defence (see {@link SENSITIVE_KEY}) at any
 * depth, and every string is clipped. JSON escaping keeps a value from forging a
 * second line.
 *
 * NEVER THROWS, NEVER AWAITS. An audit line must not turn a sign-in or a pty spawn
 * into a failure: the call is synchronous, returns nothing, and swallows its own
 * errors — including a stdout that has gone away.
 *
 * ACTING USER. A call site deep in a domain (a hub → computer pty spawn) does not
 * know who asked. {@link runWithSecurityContext} carries `{ actor, ip, route }` from
 * the tRPC and REST entry points down the async chain (AsyncLocalStorage), and
 * {@link securityEvent} fills any field its caller leaves `undefined` from there.
 * An explicit `null` stays null.
 *
 * Lean leaf (node:async_hooks only), also the `@slayzone/platform/security-log`
 * subpath.
 *
 * @module platform/security-log
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Every event name. A call site can only emit one of these, so the catalogue in
 * this list is the whole vocabulary a log query has to know.
 */
export const SECURITY_EVENTS = [
  // Sign-in and better-auth sessions (hub-auth `audit.ts`).
  'auth.signin',
  'auth.signout',
  'auth.password.change',
  'auth.session.create',
  'auth.session.revoke',
  /** A session row removed because it had expired — housekeeping, not a revocation. */
  'auth.session.expire',
  // Scoped browser sessions (`szw_`, hub `web-sessions.ts`).
  'auth.web_session.create',
  'auth.web_session.revoke',
  /** A gate refused a request: REST bearer gate, tRPC auth/scope gates, /trpc origin. */
  'authz.denied',
  // Accounts (hub-auth `users.ts`).
  'user.create',
  'user.remove',
  // Computers: enrollment credentials and lifecycle.
  'computer.join_token.mint',
  'computer.join_token.redeem',
  'computer.enroll',
  'computer.hello',
  'computer.revoke',
  'computer.unrevoke',
  'computer.delete',
  'computer.claim',
  'computer.visibility.set',
  // Privileged hub → computer calls (computer-transport `hub-audit.ts`).
  'computer.pty.spawn',
  'computer.pty.kill',
  'computer.proc.spawn',
  'computer.proc.kill',
  'computer.fs.write',
  'computer.fs.delete',
  'computer.fs.rename',
  'computer.git',
  'computer.gh',
  'computer.allowed_roots.set',
  'computer.shutdown',
  /** A boot rule refused to start the hub (hub `boot-rules.ts`). */
  'hub.boot',
  // Reserved for later work — named now so those call sites cannot invent names.
  /** T-04: a hub-local process refused (`SLAYZONE_HUB_ENABLE_PROCESSES=0`). */
  'hub.process.spawn',
  /** T-05: an automation `run_command` refused, at save or at run. */
  'automation.run_command',
  /** T-06: hub-local file/git/exec refused ("connect a computer"). */
  'hub.local_exec',
  /** T-07: an integration connect or sign-in start refused. */
  'integration.connect',
  /** T-23: the retention sweep ran; `detail` carries the row counts. */
  'hub.retention.sweep'
] as const

export type SecurityEventName = (typeof SECURITY_EVENTS)[number]

/** `success`; `failure` = attempted, did not complete; `denied` = refused by policy. */
export type SecurityOutcome = 'success' | 'failure' | 'denied'

/** Defaults: `info` for success, `warn` for failure and denied. */
export type SecurityLevel = 'info' | 'warn' | 'error'

/** What an event acted on. */
export type SecurityTargetKind =
  | 'session'
  | 'web_session'
  | 'user'
  | 'computer'
  | 'join_token'
  | 'procedure'
  | 'hub'

export interface SecurityEventInput {
  event: SecurityEventName
  outcome: SecurityOutcome
  level?: SecurityLevel
  /** User id, or computer id for a computer acting. `undefined` = from context. */
  actor?: string | null
  /** `undefined` = from context. */
  ip?: string | null
  targetKind?: SecurityTargetKind | null
  targetId?: string | null
  /** `METHOD /path` or `trpc <path>`. Query strings are cut. `undefined` = from context. */
  route?: string | null
  /** Small object of ids, codes, booleans and counts. Filtered and clipped. */
  detail?: Record<string, unknown>
}

/** Who is acting, carried down an async chain by {@link runWithSecurityContext}. */
export interface SecurityContext {
  actor: string | null
  ip: string | null
  route: string | null
}

/** Keys whose values are never emitted, at any depth, whatever a caller passes. */
const SENSITIVE_KEY =
  /pass(word|wd|phrase)|token|secret|cookie|authori[sz]ation|api[-_]?key|private[-_]?key|credential|bearer|signature|prompt|content|body|payload|stdin|stdout|stderr|bytes|email|message|^(key|data|env|args|text|input|output)$/i

const MAX_STRING = 200
const MAX_DEPTH = 4
const MAX_ITEMS = 20
const MAX_KEYS = 30

const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

const clip = (s: string): string => (s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s)

const str = (v: unknown): string | null => (typeof v === 'string' && v ? clip(v) : null)

/** JSON-safe copy of `value`: sensitive keys dropped, strings clipped, depth and
 *  breadth bounded, cycles and non-plain objects reduced to a marker. */
function clean(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null) return null
  switch (typeof value) {
    case 'string':
      return clip(value)
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    case 'object':
      break
    default:
      // undefined, functions, symbols: not loggable.
      return undefined
  }
  const obj = value as object
  if (seen.has(obj)) return '[circular]'
  if (depth >= MAX_DEPTH) return '[depth]'
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString()
  // Bytes are never logged: they are terminal output or file content.
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return '[bytes]'
  seen.add(obj)
  if (Array.isArray(obj)) {
    const out = obj.slice(0, MAX_ITEMS).map((v) => clean(v, depth + 1, seen) ?? null)
    if (obj.length > MAX_ITEMS) out.push(`…${obj.length - MAX_ITEMS} more`)
    return out
  }
  const proto = Object.getPrototypeOf(obj)
  if (proto !== Object.prototype && proto !== null) {
    // A class instance (an Error, a socket, a Map) — its fields are not a contract.
    return `[${(obj.constructor as { name?: string } | undefined)?.name || 'object'}]`
  }
  const out: Record<string, unknown> = {}
  let kept = 0
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY.test(k)) continue
    const c = clean(v, depth + 1, seen)
    if (c === undefined) continue
    if (kept++ >= MAX_KEYS) break
    out[k] = c
  }
  return out
}

/** Where a finished line goes. Swapped by tests. */
export type SecurityLogSink = (line: string) => void

let stdoutGuarded = false
const stdoutSink: SecurityLogSink = (line) => {
  // An EPIPE on stdout (the log reader went away) is emitted as an 'error' event,
  // which unhandled would take the hub down with it. A lost audit line is the log
  // pipeline's failure to report; a crashed hub is ours.
  if (!stdoutGuarded) {
    stdoutGuarded = true
    process.stdout.on('error', () => {
      // Swallowed on purpose — see above.
    })
  }
  process.stdout.write(`${line}\n`)
}
let sink: SecurityLogSink = stdoutSink

/** Test seam: capture lines instead of writing them. Pass nothing to restore stdout. */
export function setSecurityLogSink(next?: SecurityLogSink): void {
  sink = next ?? stdoutSink
}

const contextStore = new AsyncLocalStorage<SecurityContext>()

/** Run `fn` with `ctx` as the acting user/ip/route for every event in its async chain. */
export function runWithSecurityContext<T>(ctx: SecurityContext, fn: () => T): T {
  return contextStore.run(ctx, fn)
}

/**
 * Run `fn` as `actor`, keeping the current ip and route — for a handler that verifies
 * its own credential after the gate let it through unattributed.
 */
export function runAsSecurityActor<T>(actor: string | null, fn: () => T): T {
  const ctx = contextStore.getStore()
  return contextStore.run({ ip: ctx?.ip ?? null, route: ctx?.route ?? null, actor }, fn)
}

/** The context {@link runWithSecurityContext} established, if any. */
export function currentSecurityContext(): SecurityContext | undefined {
  return contextStore.getStore()
}

/** The TCP peer of a request (an `IncomingMessage` or anything shaped like one). */
export function peerAddress(
  req: { socket?: { remoteAddress?: string | undefined } | null } | null | undefined
): string | null {
  const addr = req?.socket?.remoteAddress
  return typeof addr === 'string' && addr ? addr : null
}

/** `METHOD /path` without the query string, which can carry codes. */
export function routeOf(method: string | undefined, url: string | undefined): string {
  return `${method ?? '?'} ${(url ?? '').split('?')[0]}`
}

/** Emit one security event. Never throws. */
export function securityEvent(input: SecurityEventInput): void {
  try {
    const ctx = contextStore.getStore()
    const route = input.route === undefined ? (ctx?.route ?? null) : input.route
    const detail = input.detail ? clean(input.detail, 0, new WeakSet()) : {}
    const line = JSON.stringify({
      type: 'security',
      ts: new Date().toISOString(),
      level: input.level ?? (input.outcome === 'success' ? 'info' : 'warn'),
      event: input.event,
      outcome: input.outcome,
      actor: str(input.actor === undefined ? ctx?.actor : input.actor),
      ip: str(input.ip === undefined ? ctx?.ip : input.ip),
      targetKind: str(input.targetKind),
      targetId: str(input.targetId),
      route: typeof route === 'string' ? str(route.split('?')[0]) : null,
      detail: detail && typeof detail === 'object' && !Array.isArray(detail) ? detail : {}
    })
      // Valid in JSON strings, but some line readers split on them.
      .replaceAll(LINE_SEPARATOR, '\\u2028')
      .replaceAll(PARAGRAPH_SEPARATOR, '\\u2029')
    sink(line)
  } catch {
    // See the module note: never into the caller.
  }
}
