/**
 * Address a hub over its REST surface, and report its refusals verbatim.
 *
 * ONE resolver for every command that acts ON a hub rather than on this machine's
 * hub processes — today `slay hub users add|ls|rm` and `slay runner mint`. Both
 * need the identical answer to "which hub, and with what credential", and both
 * need the identical failure wording; two copies would drift the moment one of
 * them learned about a new channel.
 *
 * Deliberately NOT `./api.ts`: that resolver answers "which hub does this command's
 * DATA live on", falling back to the local app when nothing is configured. These
 * commands act ON a hub as an object of administration, so "no hub configured" must
 * be an explicit refusal with a hint, not a silent redirect to the desktop app.
 * (It also used to differ far more sharply: api.ts's fallback opened the local
 * SQLite database, which `process.exit(1)`s on a hub-only VPS where no such file
 * exists. That fallback is gone — nothing in the CLI opens a database now.)
 *
 * @module cli/hub-request
 */
import { discoverHubs, type DiscoveredHub } from '@slayzone/platform/hub-discovery'
import { resolveHubTarget } from './hub-config'
import { fail } from './service'

/** A resolved hub REST base plus the bearer to send, if any. */
export interface HubRequestTarget {
  baseUrl: string
  token: string | null
}

/**
 * Resolve which hub a hub-side command acts on.
 *
 * Precedence:
 *   1. Whatever `resolveHubTarget()` says — which already covers the root `--hub`
 *      flag, `SLAYZONE_HUB_ADDRESS`/`_TOKEN`, and `cli-hub-target.json` (written by
 *      `slay hub use` / `slay hub login`). Reusing it means `slay --hub staging …`
 *      works with no new surface, and a remote hub is reachable through exactly the
 *      channels that already exist.
 *   2. Auto-discovery, when exactly ONE hub is running here. Refusing to guess
 *      between several is the point: minting a token on the wrong hub produces a
 *      runner that enrolls somewhere nobody is looking.
 *
 * @param what how to name this command family in the ambiguity hint, e.g.
 *             `'hub users …'` or `'runner mint'`.
 * @param discover injected so a caller can widen the sweep (the desktop app's
 *             sidecar binds outside the hub port block).
 */
export async function resolveHubRequestTarget(
  what: string,
  discover: () => Promise<DiscoveredHub[]> = () => discoverHubs()
): Promise<HubRequestTarget> {
  const configured = resolveHubTarget()
  if (configured) return configured

  const running = await discover()
  if (running.length === 0) {
    fail(
      'No hub is running on this machine.\n' +
        'Start one with `slay hub start <name>`, or name a remote hub with ' +
        '`slay --hub <name|port>` / `slay hub use <url>`.'
    )
  }
  if (running.length > 1) {
    fail(
      `Several hubs are running here, so which one to act on is ambiguous: ` +
        `${running.map((h) => `${h.name} (${h.port})`).join(', ')}.\n` +
        `Name one with \`slay --hub <name|port> ${what}\`.`
    )
  }
  // Discovery only reaches loopback, so the scheme is always plain http.
  return { baseUrl: `http://127.0.0.1:${running[0]!.port}`, token: null }
}

/** Extra guidance appended to a hub's own error text, keyed by status. */
export type StatusHints = Partial<Record<number, string>>

/**
 * Call a hub REST endpoint and return the parsed payload, or exit with the hub's
 * own error text.
 *
 * The hub's messages are surfaced verbatim: they explain the refusals (a last
 * remaining account, a listener that has not bound yet) far better than anything
 * reconstructible from a status code. `hints` adds a CLI-side next step for the
 * statuses where the hub cannot know what the operator should run — notably 401
 * ("sign in") and 403 ("wrong machine").
 *
 * @param unwrap `'data'` for the `{ok, data}` envelope the `/api/hub/*` routes use;
 *               `'raw'` for a route that returns its payload at the top level (the
 *               older `/api/runners/join-token` shape).
 */
export async function hubRequest<T>(opts: {
  target: HubRequestTarget
  path: string
  method: string
  body?: Record<string, unknown>
  unwrap: 'data' | 'raw'
  hints?: StatusHints
  timeoutMs?: number
}): Promise<T> {
  const { target, path, method, body, unwrap } = opts
  const url = `${target.baseUrl}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(target.token ? { Authorization: `Bearer ${target.token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000)
    })
  } catch {
    fail(`Could not reach the hub at ${target.baseUrl}.`)
  }
  const text = await res.text().catch(() => '')
  let parsed: { ok?: boolean; data?: T; error?: string; message?: string } = {}
  try {
    parsed = text ? (JSON.parse(text) as typeof parsed) : {}
  } catch {
    /* fall through to the status-based message below */
  }
  if (!res.ok) {
    const detail = parsed.message ? ` (${parsed.message})` : ''
    const hint = opts.hints?.[res.status]
    fail(`${parsed.error ?? `HTTP ${res.status}`}${detail}${hint ? `\n\n${hint}` : ''}`)
  }
  return unwrap === 'data' ? (parsed.data as T) : (parsed as unknown as T)
}
