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

function fakeReqRes(
  url: string,
  method = 'POST',
  // `null` (not `undefined`) means "socket reports no address" — passing
  // `undefined` for an optional parameter triggers its DEFAULT, which would
  // silently turn the absent-peer case back into a loopback one.
  remoteAddress: string | null = '127.0.0.1'
): {
  req: never
  res: never
  status: () => number | null
} {
  let status: number | null = null
  const req = {
    method,
    url,
    // `handleDevSql` requires a loopback PEER, so the fixture has to carry one.
    // Default 127.0.0.1 = the only shape the e2e harness ever produces; pass an
    // off-box address (or undefined) to exercise the refusal.
    socket: { remoteAddress: remoteAddress ?? undefined },
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

/**
 * `PLAYWRIGHT=1` is an INHERITED environment variable, not a credential. It is
 * not in `ENV_MANIFEST`, so nothing strips it from a spawned process — any parent
 * that happens to carry it turns arbitrary SQL on. e2e proves this is not
 * hypothetical: the standalone hubs in e2e/computers/112-multi-hub-federation.spec.ts
 * build a `cleanEnv` that strips only `ELECTRON_*` and `SLAYZONE_*`, so those hubs
 * boot with the flag set.
 *
 * The peer check is what contains that. It is deliberately independent of the
 * bearer gate: this endpoint should not trust the network at all, whatever the
 * gate happens to be configured to do.
 */
test('refuses a non-loopback peer even under PLAYWRIGHT=1', () => {
  process.env.PLAYWRIGHT = '1'

  for (const addr of ['203.0.113.7', '10.0.0.4', '::ffff:203.0.113.7']) {
    const offBox = fakeReqRes(DEV_SQL_PATH, 'POST', addr)
    expect(handleDevSql(h.slayDb, offBox.req, offBox.res)).toBe(false)
    expect(offBox.status()).toBe(null)
  }

  // An unknown peer fails CLOSED — "cannot tell" must never mean "trusted".
  const unknown = fakeReqRes(DEV_SQL_PATH, 'POST', null)
  expect(handleDevSql(h.slayDb, unknown.req, unknown.res)).toBe(false)

  // Every loopback form the kernel reports still works, so the guard did not
  // simply disable the endpoint.
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) {
    const onBox = fakeReqRes(DEV_SQL_PATH, 'POST', addr)
    expect(handleDevSql(h.slayDb, onBox.req, onBox.res)).toBe(true)
  }

  if (priorFlag === undefined) delete process.env.PLAYWRIGHT
  else process.env.PLAYWRIGHT = priorFlag
})
