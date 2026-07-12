/**
 * Unit tests for createRemoteMcpEnvProvider — the fleet-mode provider the
 * composition root injects via setRemoteMcpEnvProvider (hub/runner split, wave
 * 3.5). Asserts the RemoteMcpEnv contract: a runner-routed spawn resolves the
 * hub base URL (public-url override vs loopback boundPort) + mints a bearer that
 * verifyTaskToken accepts with the right scope; a taskless spawn yields a null
 * token; an unresolvable base yields null (→ loopback fallback upstream).
 *
 * Run with: npx tsx packages/apps/server/src/remote-mcp-env-provider.test.ts
 * (the run-all.sh test-utils loader mocks the better-auth barrel dep).
 */
import { createRemoteMcpEnvProvider, TASK_TOKEN_TTL_MS } from './remote-mcp-env-provider'
import { verifyTaskToken } from '@slayzone/hub-auth/server'

let pass = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  pass++
}

const SECRET = 'fleet-secret-under-test-at-least-long-enough'

// Isolate SLAYZONE_HUB_PUBLIC_URL per case (the provider reads it live).
function withPublicUrl<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.SLAYZONE_HUB_PUBLIC_URL
  if (value === undefined) delete process.env.SLAYZONE_HUB_PUBLIC_URL
  else process.env.SLAYZONE_HUB_PUBLIC_URL = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.SLAYZONE_HUB_PUBLIC_URL
    else process.env.SLAYZONE_HUB_PUBLIC_URL = prev
  }
}

// 1. Loopback base (no public URL) + a task → hubBaseUrl matches boundPort, and
//    the minted token verifies under the SAME secret with the right scope.
withPublicUrl(undefined, () => {
  const before = Date.now()
  const provider = createRemoteMcpEnvProvider({ fleetSecret: SECRET, getBoundPort: () => 4141 })
  const env = provider({ taskId: 'task-1', runnerId: 'runner-a' })
  assert(env !== null, 'runner-routed spawn must resolve a non-null target')
  assert(env!.runnerId === 'runner-a', 'runnerId echoed back')
  assert(env!.hubBaseUrl === 'http://127.0.0.1:4141', `loopback base on boundPort, got ${env!.hubBaseUrl}`)
  assert(typeof env!.token === 'string' && env!.token.length > 0, 'token minted for a bound task')
  const verified = verifyTaskToken(SECRET, env!.token!)
  assert(verified.ok === true, 'minted token must verify under the same secret')
  if (verified.ok) {
    assert(verified.claims.taskId === 'task-1', 'token scoped to the task')
    assert(verified.claims.runnerId === 'runner-a', 'token scoped to the runner')
    assert(
      verified.claims.exp - verified.claims.iat === TASK_TOKEN_TTL_MS,
      'token ttl matches TASK_TOKEN_TTL_MS'
    )
    assert(verified.claims.iat >= before, 'iat is fresh (minted at call time)')
  }
})

// 2. A wrong secret must NOT verify the minted token (secret is load-bearing).
withPublicUrl(undefined, () => {
  const provider = createRemoteMcpEnvProvider({ fleetSecret: SECRET, getBoundPort: () => 4141 })
  const env = provider({ taskId: 'task-2', runnerId: 'r' })
  const bad = verifyTaskToken('a-totally-different-secret-value!!', env!.token!)
  assert(bad.ok === false, 'token must not verify under a different secret')
})

// 3. SLAYZONE_HUB_PUBLIC_URL override wins over loopback + trailing slash stripped.
withPublicUrl('https://hub.example:8443/', () => {
  const provider = createRemoteMcpEnvProvider({ fleetSecret: SECRET, getBoundPort: () => 4141 })
  const env = provider({ taskId: 'task-3', runnerId: 'r' })
  assert(
    env!.hubBaseUrl === 'https://hub.example:8443',
    `public url override wins + no trailing slash, got ${env!.hubBaseUrl}`
  )
})

// 3b. A set-but-malformed public URL (no scheme) → null, NOT a silent loopback
//     substitution (operator asked for a remote base; degrade via the contract).
withPublicUrl('hub.example:8443', () => {
  const provider = createRemoteMcpEnvProvider({ fleetSecret: SECRET, getBoundPort: () => 4141 })
  assert(provider({ taskId: 't', runnerId: 'r' }) === null, 'malformed public URL → null')
})

// 3c. A non-http(s) scheme is rejected too.
withPublicUrl('ftp://hub.example', () => {
  const provider = createRemoteMcpEnvProvider({ fleetSecret: SECRET, getBoundPort: () => 4141 })
  assert(provider({ taskId: 't', runnerId: 'r' }) === null, 'non-http(s) public URL → null')
})

// 4. Taskless spawn (pooled agent, taskId undefined) → base resolved, token null.
withPublicUrl(undefined, () => {
  const provider = createRemoteMcpEnvProvider({ fleetSecret: SECRET, getBoundPort: () => 4141 })
  const env = provider({ taskId: undefined, runnerId: 'r' })
  assert(env !== null, 'taskless spawn still resolves a base')
  assert(env!.token === null, 'no task → null token (nothing to scope to)')
})

// 5. Unresolvable base (port not bound yet, no public URL) → null (→ loopback
//    fallback upstream, never a poisoned/unreachable hub target).
withPublicUrl(undefined, () => {
  const provider = createRemoteMcpEnvProvider({ fleetSecret: SECRET, getBoundPort: () => 0 })
  const env = provider({ taskId: 'task-5', runnerId: 'r' })
  assert(env === null, 'no reachable base → null')
})

// 6. boundPort read LAZILY: same provider returns null before bind, a real base
//    after — proving the closure reads the port at call time, not at build time.
withPublicUrl(undefined, () => {
  let port = 0
  const provider = createRemoteMcpEnvProvider({ fleetSecret: SECRET, getBoundPort: () => port })
  assert(provider({ taskId: 't', runnerId: 'r' }) === null, 'null while port unbound')
  port = 5555
  const env = provider({ taskId: 't', runnerId: 'r' })
  assert(env?.hubBaseUrl === 'http://127.0.0.1:5555', 'picks up boundPort once set (lazy read)')
})

console.log(`OK — createRemoteMcpEnvProvider ${pass} checks passed`)
