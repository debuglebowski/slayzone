/**
 * `SLAYZONE_HUB_ENABLE_INTEGRATIONS=0` (T-07): every connect refuses before its
 * provider round-trip, no `integration:credential:*` row is written, and a credential
 * left from before the switch was turned off cannot be read — so no provider call can
 * be made with it. One `integration.connect` audit line per refusal. Defaults (switch
 * unset) are credentials.test.ts and the integrations router test.
 *
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../shared/test-utils/ipc-harness.js'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { isHubSwitchedOffError } from '@slayzone/platform/hub-switch-refusal'
import { createIntegrationOps, ensureIntegrationSchema } from './handlers-store.js'
import { readCredential, setCredentialCipher, storeCredential } from './credentials.js'

const h = await createTestHarness()
await ensureIntegrationSchema(h.slayDb)
setCredentialCipher(null)
const ops = createIntegrationOps(h.slayDb)

const lines: Array<{ event: string; outcome: string; detail: Record<string, unknown> }> = []
setSecurityLogSink((line) => lines.push(JSON.parse(line)))

// Any provider round-trip would go through fetch (GitHub, Jira) — count them.
let fetchCalls = 0
const realFetch = globalThis.fetch
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  fetchCalls++
  return realFetch(...args)
}) as typeof fetch

const credentialRows = (): number =>
  (
    h.db
      .prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'integration:credential:%'")
      .get() as { n: number }
  ).n

// A connection + credential saved while integrations were still on.
const connId = crypto.randomUUID()
h.db
  .prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('integration:credential:old-ref', 'plain:ghp_old')"
  )
  .run()
h.db
  .prepare(
    `INSERT INTO integration_connections (id, provider, credential_ref, enabled, created_at, updated_at)
     VALUES (?, 'github', 'old-ref', 1, datetime('now'), datetime('now'))`
  )
  .run(connId)

async function refused(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

process.env.SLAYZONE_HUB_ENABLE_INTEGRATIONS = '0'

await describe('integrations switched off', () => {
  const connects: Array<[string, () => Promise<unknown>]> = [
    ['github', () => ops.connectGithub({ token: 'ghp_new' } as never)],
    ['linear', () => ops.connectLinear({ apiKey: 'lin_new' } as never)],
    [
      'jira',
      () =>
        ops.connectJira({
          cloudDomain: 'acme.atlassian.net',
          email: 'a@b.c',
          apiToken: 'tok'
        } as never)
    ],
    ['update', () => ops.updateConnection({ connectionId: connId, credential: 'ghp_rot' } as never)]
  ]
  for (const [name, fn] of connects) {
    test(`connect ${name}: refused before any provider call, one audit line`, async () => {
      const before = lines.length
      const err = await refused(fn)
      expect(isHubSwitchedOffError(err)).toBe(true)
      expect((err as { code: string }).code).toBe('HUB_INTEGRATIONS_DISABLED')
      expect(lines.length).toBe(before + 1)
      expect(lines[before].event).toBe('integration.connect')
      expect(lines[before].outcome).toBe('denied')
      expect(lines[before].detail.op).toBe('connect')
      expect(fetchCalls).toBe(0)
    })
  }

  test('storeCredential: refused, no row written', async () => {
    const before = credentialRows()
    const err = await refused(() => storeCredential(h.slayDb, 'new-ref', 'secret'))
    expect(isHubSwitchedOffError(err)).toBe(true)
    expect(lines[lines.length - 1].detail.op).toBe('credential.store')
    expect(credentialRows()).toBe(before)
  })

  test('readCredential: a row from before the switch cannot be used', async () => {
    const err = await refused(() => readCredential(h.slayDb, 'old-ref'))
    expect(isHubSwitchedOffError(err)).toBe(true)
    expect(lines[lines.length - 1].detail.op).toBe('credential.read')
  })

  test('provider call with an old connection: refused, no traffic', async () => {
    const err = await refused(() => ops.listGithubRepositories(connId))
    expect(isHubSwitchedOffError(err)).toBe(true)
    expect(fetchCalls).toBe(0)
  })

  test('local reads keep working', async () => {
    const conns = (await ops.listConnections()) as Array<{ id: string }>
    expect(conns.some((c) => c.id === connId)).toBe(true)
  })

  test('no credential row was added by anything above', () => {
    expect(credentialRows()).toBe(1)
  })
})

await describe('integrations on (default)', () => {
  test('storeCredential writes again once the switch is unset', async () => {
    delete process.env.SLAYZONE_HUB_ENABLE_INTEGRATIONS
    const before = lines.length
    await storeCredential(h.slayDb, 'default-ref', 'secret')
    expect(await readCredential(h.slayDb, 'default-ref')).toBe('secret')
    expect(lines.length).toBe(before)
  })
})

globalThis.fetch = realFetch
setSecurityLogSink()
