/**
 * The E2E-only raw-SQL route.
 *
 * The route itself is trivial; the GATE is the point. This is arbitrary SQL
 * against the hub's database on a listener that, in remote mode, faces the
 * internet. So the thing worth testing is that it is ABSENT in a normal boot —
 * an unchecked gate is one that quietly stops working after some future refactor
 * moves the env read around.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/dev-sql.test.ts
 */
import { createTestHarness, test, expect } from '../../../shared/test-utils/ipc-harness.js'
import { handleDevSql, isDevSqlEnabled, DEV_SQL_PATH } from './dev-sql.js'

const h = await createTestHarness()

const priorFlag = process.env.PLAYWRIGHT

function fakeReqRes(url: string, method = 'POST'): {
  req: never
  res: never
  status: () => number | null
} {
  let status: number | null = null
  const req = {
    method,
    url,
    setEncoding: () => {},
    on: () => {}
  }
  const res = {
    writeHead: (code: number) => {
      status = code
    },
    end: () => {}
  }
  return { req: req as never, res: res as never, status: () => status }
}

test('DISABLED without PLAYWRIGHT=1 — the route does not exist', () => {
  delete process.env.PLAYWRIGHT
  expect(isDevSqlEnabled()).toBe(false)
  const { req, res, status } = fakeReqRes(DEV_SQL_PATH)
  // false = "not handled", so the caller falls through and the path 404s.
  expect(handleDevSql(h.slayDb, req, res)).toBe(false)
  expect(status()).toBe(null)
})

test('enabled under PLAYWRIGHT=1, and only for its own path + method', () => {
  process.env.PLAYWRIGHT = '1'
  expect(isDevSqlEnabled()).toBe(true)

  const own = fakeReqRes(DEV_SQL_PATH)
  expect(handleDevSql(h.slayDb, own.req, own.res)).toBe(true)

  // Never claims another route, and never a non-POST.
  const other = fakeReqRes('/api/tasks')
  expect(handleDevSql(h.slayDb, other.req, other.res)).toBe(false)
  const wrongMethod = fakeReqRes(DEV_SQL_PATH, 'GET')
  expect(handleDevSql(h.slayDb, wrongMethod.req, wrongMethod.res)).toBe(false)

  if (priorFlag === undefined) delete process.env.PLAYWRIGHT
  else process.env.PLAYWRIGHT = priorFlag
})
