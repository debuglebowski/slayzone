/**
 * Unit tests for createRemoteMcpEnvProvider — the runner-transport provider the
 * composition root injects via setRemoteMcpEnvProvider (hub/runner split). Asserts
 * the RemoteMcpEnv contract: a runner-routed spawn resolves the hub base URL
 * (public-url override vs loopback boundPort); an unresolvable base yields null
 * (→ loopback fallback upstream). The base URL is used ONLY by the `slay` CLI's
 * hub REST access — the agent lifecycle HOOK posts to the runner's own loopback
 * relay, so NO per-task bearer is minted here anymore.
 *
 * Run with: npx tsx packages/apps/hub/src/remote-mcp-env-provider.test.ts
 */
import { createRemoteMcpEnvProvider } from './remote-mcp-env-provider'

let pass = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  pass++
}

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

// 1. Loopback base (no public URL) + a task → hubBaseUrl matches boundPort. No
//    token is produced (the field was removed — the hook uses runner loopback).
withPublicUrl(undefined, () => {
  const provider = createRemoteMcpEnvProvider({ getBoundPort: () => 4141 })
  const env = provider({ taskId: 'task-1', runnerId: 'runner-a' })
  assert(env !== null, 'runner-routed spawn must resolve a non-null target')
  assert(env!.runnerId === 'runner-a', 'runnerId echoed back')
  assert(env!.hubBaseUrl === 'http://127.0.0.1:4141', `loopback base on boundPort, got ${env!.hubBaseUrl}`)
  assert(!('token' in (env as object)), 'no bearer field on the resolved env (token plumbing removed)')
})

// 2. SLAYZONE_HUB_PUBLIC_URL override wins over loopback + trailing slash stripped.
withPublicUrl('https://hub.example:8443/', () => {
  const provider = createRemoteMcpEnvProvider({ getBoundPort: () => 4141 })
  const env = provider({ taskId: 'task-3', runnerId: 'r' })
  assert(
    env!.hubBaseUrl === 'https://hub.example:8443',
    `public url override wins + no trailing slash, got ${env!.hubBaseUrl}`
  )
})

// 2b. A set-but-malformed public URL (no scheme) → null, NOT a silent loopback
//     substitution (operator asked for a remote base; degrade via the contract).
withPublicUrl('hub.example:8443', () => {
  const provider = createRemoteMcpEnvProvider({ getBoundPort: () => 4141 })
  assert(provider({ taskId: 't', runnerId: 'r' }) === null, 'malformed public URL → null')
})

// 2c. A non-http(s) scheme is rejected too.
withPublicUrl('ftp://hub.example', () => {
  const provider = createRemoteMcpEnvProvider({ getBoundPort: () => 4141 })
  assert(provider({ taskId: 't', runnerId: 'r' }) === null, 'non-http(s) public URL → null')
})

// 3. Taskless spawn (pooled agent, taskId undefined) → base still resolved.
withPublicUrl(undefined, () => {
  const provider = createRemoteMcpEnvProvider({ getBoundPort: () => 4141 })
  const env = provider({ taskId: undefined, runnerId: 'r' })
  assert(env !== null, 'taskless spawn still resolves a base')
  assert(env!.hubBaseUrl === 'http://127.0.0.1:4141', 'taskless base on boundPort')
})

// 4. Unresolvable base (port not bound yet, no public URL) → null (→ loopback
//    fallback upstream, never a poisoned/unreachable hub target).
withPublicUrl(undefined, () => {
  const provider = createRemoteMcpEnvProvider({ getBoundPort: () => 0 })
  const env = provider({ taskId: 'task-5', runnerId: 'r' })
  assert(env === null, 'no reachable base → null')
})

// 5. boundPort read LAZILY: same provider returns null before bind, a real base
//    after — proving the closure reads the port at call time, not at build time.
withPublicUrl(undefined, () => {
  let port = 0
  const provider = createRemoteMcpEnvProvider({ getBoundPort: () => port })
  assert(provider({ taskId: 't', runnerId: 'r' }) === null, 'null while port unbound')
  port = 5555
  const env = provider({ taskId: 't', runnerId: 'r' })
  assert(env?.hubBaseUrl === 'http://127.0.0.1:5555', 'picks up boundPort once set (lazy read)')
})

console.log(`OK — createRemoteMcpEnvProvider ${pass} checks passed`)
