/**
 * Unit tests for createRemoteMcpEnvProvider — the computer-transport provider the
 * composition root injects via setRemoteMcpEnvProvider (hub/computer split). Asserts
 * the RemoteMcpEnv contract: a computer-routed spawn resolves the hub base URL
 * (public-url override vs loopback boundPort); an unresolvable base yields null
 * (→ loopback fallback upstream). The base URL is used ONLY by the `slay` CLI's
 * hub REST access — the agent lifecycle HOOK posts to the computer's own loopback
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

// Isolate SLAYZONE_HUB_PUBLIC_ADDRESS (+ the MODE that decides the scheme) per
// case — the provider reads both live.
function withPublicAddress<T>(value: string | undefined, fn: () => T, mode?: string): T {
  const prev = process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
  const prevMode = process.env.SLAYZONE_MODE
  if (value === undefined) delete process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
  else process.env.SLAYZONE_HUB_PUBLIC_ADDRESS = value
  if (mode === undefined) delete process.env.SLAYZONE_MODE
  else process.env.SLAYZONE_MODE = mode
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
    else process.env.SLAYZONE_HUB_PUBLIC_ADDRESS = prev
    if (prevMode === undefined) delete process.env.SLAYZONE_MODE
    else process.env.SLAYZONE_MODE = prevMode
  }
}

// 1. Loopback base (no public URL) + a task → hubBaseUrl matches boundPort. No
//    token is produced (the field was removed — the hook uses computer loopback).
withPublicAddress(undefined, () => {
  const provider = createRemoteMcpEnvProvider({ getBoundPort: () => 4141 })
  const env = provider({ taskId: 'task-1', computerId: 'computer-a' })
  assert(env !== null, 'computer-routed spawn must resolve a non-null target')
  assert(env!.computerId === 'computer-a', 'computerId echoed back')
  assert(
    env!.hubBaseUrl === 'http://127.0.0.1:4141',
    `loopback base on boundPort, got ${env!.hubBaseUrl}`
  )
  assert(
    !('token' in (env as object)),
    'no bearer field on the resolved env (token plumbing removed)'
  )
})

// 2. SLAYZONE_HUB_PUBLIC_ADDRESS wins over loopback; scheme comes from MODE
//    (remote → https), never from the value.
withPublicAddress(
  'hub.example:8443',
  () => {
    const provider = createRemoteMcpEnvProvider({ getBoundPort: () => 4141 })
    const env = provider({ taskId: 'task-3', computerId: 'r' })
    assert(
      env!.hubBaseUrl === 'https://hub.example:8443',
      `public address wins, https from remote MODE, got ${env!.hubBaseUrl}`
    )
  },
  'remote'
)

// 2a. Same address in local MODE → http. Proves the scheme tracks MODE alone, so
//     it can never disagree with the computer's ws(s) reading of the same hub.
withPublicAddress(
  'hub.example:8443',
  () => {
    const provider = createRemoteMcpEnvProvider({ getBoundPort: () => 4141 })
    const env = provider({ taskId: 'task-3', computerId: 'r' })
    assert(
      env!.hubBaseUrl === 'http://hub.example:8443',
      `local MODE → http, got ${env!.hubBaseUrl}`
    )
  },
  'local'
)

// 2b. A value carrying a SCHEME is malformed now (the channel is authority-only)
//     → null, NOT a silent loopback substitution (the operator asked for a remote
//     base; degrade via the contract).
withPublicAddress('https://hub.example:8443', () => {
  const provider = createRemoteMcpEnvProvider({ getBoundPort: () => 4141 })
  assert(provider({ taskId: 't', computerId: 'r' }) === null, 'address carrying a scheme → null')
})

// 2c. A value carrying a PATH is rejected too (no path-prefixed proxy mount).
withPublicAddress('hub.example:8443/slayzone', () => {
  const provider = createRemoteMcpEnvProvider({ getBoundPort: () => 4141 })
  assert(provider({ taskId: 't', computerId: 'r' }) === null, 'address carrying a path → null')
})

// 3. Taskless spawn (pooled agent, taskId undefined) → base still resolved.
withPublicAddress(undefined, () => {
  const provider = createRemoteMcpEnvProvider({ getBoundPort: () => 4141 })
  const env = provider({ taskId: undefined, computerId: 'r' })
  assert(env !== null, 'taskless spawn still resolves a base')
  assert(env!.hubBaseUrl === 'http://127.0.0.1:4141', 'taskless base on boundPort')
})

// 4. Unresolvable base (port not bound yet, no public URL) → null (→ loopback
//    fallback upstream, never a poisoned/unreachable hub target).
withPublicAddress(undefined, () => {
  const provider = createRemoteMcpEnvProvider({ getBoundPort: () => 0 })
  const env = provider({ taskId: 'task-5', computerId: 'r' })
  assert(env === null, 'no reachable base → null')
})

// 5. boundPort read LAZILY: same provider returns null before bind, a real base
//    after — proving the closure reads the port at call time, not at build time.
withPublicAddress(undefined, () => {
  let port = 0
  const provider = createRemoteMcpEnvProvider({ getBoundPort: () => port })
  assert(provider({ taskId: 't', computerId: 'r' }) === null, 'null while port unbound')
  port = 5555
  const env = provider({ taskId: 't', computerId: 'r' })
  assert(env?.hubBaseUrl === 'http://127.0.0.1:5555', 'picks up boundPort once set (lazy read)')
})

console.log(`OK — createRemoteMcpEnvProvider ${pass} checks passed`)
