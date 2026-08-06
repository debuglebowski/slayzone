import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SlayzoneDb } from '@slayzone/platform'
import {
  notifyGlobalStateListeners,
  markSessionUserInput,
  clearSessionUserInputMark
} from '@slayzone/terminal/server'

/**
 * `POST /api/dev/sql` — raw SQL against the hub's database, for E2E ONLY.
 *
 * Exists because the Electron host no longer opens the shared database, and four
 * e2e specs drive it through a `globalThis.__db` handle inside
 * `electronApp.evaluate(...)`. Rather than rewrite those specs, main keeps the
 * same `__db` shape and forwards each call here — the specs stay byte-identical
 * and the host still holds no connection.
 *
 * GATING IS THE WHOLE DESIGN. This is arbitrary SQL on a loopback port that, in
 * remote mode, is an internet-facing listener. It is registered only when
 * `PLAYWRIGHT=1`, and `isDevSqlEnabled()` is exported so a test can assert the
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
export function handleDevSql(
  db: SlayzoneDb,
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  if (!isDevSqlEnabled()) return false
  const path = (req.url ?? '').split('?')[0]
  if (req.method !== 'POST') return false
  if (
    path !== DEV_SQL_PATH &&
    path !== DEV_RESET_PATH &&
    path !== DEV_PTY_STATE_PATH &&
    path !== DEV_USER_INPUT_PATH
  ) {
    return false
  }

  if (path === DEV_RESET_PATH) {
    void (async () => {
      try {
        // Drops every table, re-migrates, re-seeds. Runs HERE because this is the
        // process holding the connection it rebuilds.
        await db.namedTxn('db:reset-for-test', {})
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
