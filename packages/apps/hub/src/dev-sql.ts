import type { IncomingMessage, ServerResponse } from 'node:http'
import { isLoopbackPeer, type SlayzoneDb } from '@slayzone/platform'
import type { HubComputerGateway } from '@slayzone/computer-transport/server'
import {
  notifyGlobalStateListeners,
  markSessionUserInput,
  clearSessionUserInputMark
} from '@slayzone/terminal/server'
// Loads the TxnRegistry augmentation that types this file's `db.namedTxn` calls.
import type {} from '@slayzone/api/txns'

/**
 * `POST /api/dev/sql` — raw SQL against the hub's database, for E2E ONLY.
 *
 * Exists because the Electron host no longer opens the shared database, and four
 * e2e specs drive it through a `globalThis.__db` handle inside
 * `electronApp.evaluate(...)`. Rather than rewrite those specs, main keeps the
 * same `__db` shape and forwards each call here — the specs stay byte-identical
 * and the host still holds no connection.
 *
 * GATING IS THE WHOLE DESIGN. This is arbitrary SQL on a loopback port that, on a hub
 * other machines can reach, is a network-facing listener. It is registered only when
 * `PLAYWRIGHT=1` — and the hub refuses to boot with `PLAYWRIGHT=1` when it is
 * reachable (rule B10) — and `isDevSqlEnabled()` is exported so a test can assert the
 * route is ABSENT in a normal boot — a gate nobody checks is a gate that
 * eventually stops working.
 */
export function isDevSqlEnabled(): boolean {
  return process.env.PLAYWRIGHT === '1'
}

export const DEV_SQL_PATH = '/api/dev/sql'
/** Full schema rebuild for e2e isolation — the `db:reset-for-test` named txn. */
export const DEV_RESET_PATH = '/api/dev/reset'
/**
 * E2E seams for the pty state machine. They live here for the same reason
 * `/api/dev/sql` does: the listeners that react to a state transition (attention
 * flag, task auto-move) and the user-input mark that gates them are BOTH in this
 * process. Driving them from the host reached its own empty registry — which is
 * how `91-attention-flag.spec.ts` started failing when the host's duplicate
 * listener was removed.
 */
export const DEV_PTY_STATE_PATH = '/api/dev/pty-state'
export const DEV_USER_INPUT_PATH = '/api/dev/user-input-mark'
/**
 * Resolves once ≥1 computer is usable. The e2e reset restarts the side-car, which
 * builds a fresh gateway: the local computer (healthy) has to re-dial before
 * anything can spawn. This lets the reset return exactly when it has, instead of
 * the harness sleeping a fixed 600ms that was ~350ms too long on an idle box and
 * too short under full-suite load.
 */
export const DEV_AWAIT_USABLE_COMPUTER_PATH = '/api/dev/await-usable-computer'
const AWAIT_USABLE_COMPUTER_TIMEOUT_MS = 15_000

/**
 * True once `gateway` has a usable computer, false after `timeoutMs` (or with no
 * gateway). Event-driven: re-checks on every `computer-connected`, never polls —
 * an earlier renderer-side poll in every beforeAll became the suite's bottleneck.
 */
export function awaitUsableComputer(
  gateway: Pick<HubComputerGateway, 'listUsableComputers' | 'events'> | null,
  timeoutMs: number
): Promise<boolean> {
  if (!gateway) return Promise.resolve(false)
  if (gateway.listUsableComputers().length > 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const finish = (usable: boolean): void => {
      clearTimeout(timer)
      unsubscribe()
      resolve(usable)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const unsubscribe = gateway.events.on('computer-connected', () => {
      if (gateway.listUsableComputers().length > 0) finish(true)
    })
  })
}

type DevSqlBody = {
  method: 'get' | 'all' | 'run' | 'exec'
  sql: string
  params?: unknown[]
}

/**
 * Returns true when it handled the request. Callers dispatch before the normal
 * REST stack; when the gate is off this always returns false, so the path simply
 * 404s like any other unknown route.
 */
export type DevSqlDeps = {
  getGateway?: () => HubComputerGateway | null
  /** The composition's in-process full reset. Absent = schema rebuild only. */
  resetForTest?: () => Promise<void>
}

export function handleDevSql(
  db: SlayzoneDb,
  req: IncomingMessage,
  res: ServerResponse,
  deps: DevSqlDeps = {}
): boolean {
  if (!isDevSqlEnabled()) return false
  // Co-located callers only, INDEPENDENT of the bearer gate. `PLAYWRIGHT=1` is an
  // inherited environment variable, not a credential — it is not in `ENV_MANIFEST`,
  // so nothing strips it from a spawned process, and any parent that happens to
  // carry it turns arbitrary SQL on. The e2e harness always drives this over
  // loopback, so requiring loopback costs it nothing and removes the network as an
  // attack surface entirely. `startServer` additionally refuses to boot with this
  // enabled on a non-supervised hub; this is the second layer.
  if (!isLoopbackPeer(req.socket?.remoteAddress)) return false
  const path = (req.url ?? '').split('?')[0]
  if (req.method !== 'POST') return false
  if (
    path !== DEV_SQL_PATH &&
    path !== DEV_RESET_PATH &&
    path !== DEV_PTY_STATE_PATH &&
    path !== DEV_USER_INPUT_PATH &&
    path !== DEV_AWAIT_USABLE_COMPUTER_PATH
  ) {
    return false
  }

  if (path === DEV_AWAIT_USABLE_COMPUTER_PATH) {
    void awaitUsableComputer(deps.getGateway?.() ?? null, AWAIT_USABLE_COMPUTER_TIMEOUT_MS).then(
      (usable) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result: { usable } }))
      }
    )
    return true
  }

  if (path === DEV_RESET_PATH) {
    void (async () => {
      try {
        // Drops every table, re-migrates, re-seeds — and, with the composition's
        // `resetForTest`, also stops every agent/process and clears every runtime
        // cache, so the host no longer restarts this process. Runs HERE because
        // this is the process holding the connection it rebuilds.
        if (deps.resetForTest) await deps.resetForTest()
        else await db.namedTxn('db:reset-for-test', {})
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(err) }))
      }
    })()
    return true
  }

  if (path === DEV_PTY_STATE_PATH || path === DEV_USER_INPUT_PATH) {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => {
      body += c
    })
    req.on('end', () => {
      void (async () => {
        try {
          const p = JSON.parse(body) as {
            sid: string
            next?: string
            prev?: string
            mark?: boolean
          }
          if (path === DEV_PTY_STATE_PATH) {
            await notifyGlobalStateListeners(p.sid, p.next as never, p.prev as never)
          } else if (p.mark) {
            markSessionUserInput(p.sid)
          } else {
            clearSessionUserInputMark(p.sid)
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String(err) }))
        }
      })()
    })
    return true
  }

  let raw = ''
  req.setEncoding('utf8')
  req.on('data', (chunk: string) => {
    raw += chunk
  })
  req.on('end', () => {
    void (async () => {
      try {
        const body = JSON.parse(raw) as DevSqlBody
        const params = body.params ?? []
        const result =
          body.method === 'get'
            ? await db.get(body.sql, params)
            : body.method === 'all'
              ? await db.all(body.sql, params)
              : body.method === 'run'
                ? await db.run(body.sql, params)
                : await db.exec(body.sql)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result: result ?? null }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(err) }))
      }
    })()
  })
  return true
}
