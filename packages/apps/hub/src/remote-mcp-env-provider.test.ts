/**
 * Unit tests for createRemoteMcpEnvProvider — the computer-transport provider the
 * composition root injects via setRemoteMcpEnvProvider (hub/computer split). Asserts
 * the RemoteMcpEnv contract: a computer-routed spawn resolves the hub base URL
 * (public-url override vs loopback boundPort); an unresolvable base yields null
 * (→ loopback fallback upstream). The base URL is used ONLY by the `slay` CLI's
 * hub REST access — the agent lifecycle HOOK posts to the computer's own loopback
 * relay, so NO per-task bearer is minted here anymore.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/remote-mcp-env-provider.test.ts
 */
import { describe, expect, test } from 'vitest'
import { createRemoteMcpEnvProvider } from './remote-mcp-env-provider'

// Isolate SLAYZONE_HUB_PUBLIC_ADDRESS per case — the provider reads it live. (A
// leftover SLAYZONE_MODE must change nothing; `leftoverMode` proves it below.)
function withPublicAddress<T>(value: string | undefined, fn: () => T, leftoverMode?: string): T {
  const prev = process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
  const prevMode = process.env.SLAYZONE_MODE
  if (value === undefined) delete process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
  else process.env.SLAYZONE_HUB_PUBLIC_ADDRESS = value
  if (leftoverMode === undefined) delete process.env.SLAYZONE_MODE
  else process.env.SLAYZONE_MODE = leftoverMode
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.SLAYZONE_HUB_PUBLIC_ADDRESS
    else process.env.SLAYZONE_HUB_PUBLIC_ADDRESS = prev
    if (prevMode === undefined) delete process.env.SLAYZONE_MODE
    else process.env.SLAYZONE_MODE = prevMode
  }
}

/** One computer-routed spawn's resolved env under a given public address. */
const resolve = (
  address: string | undefined,
  input: { taskId: string | undefined; computerId: string },
  port = 4141,
  leftoverMode?: string
) =>
  withPublicAddress(
    address,
    () => createRemoteMcpEnvProvider({ getBoundPort: () => port })(input),
    leftoverMode
  )

// 1. Loopback base (no public URL) + a task → hubBaseUrl matches boundPort. No
//    token is produced (the field was removed — the hook uses computer loopback).
describe('loopback base (no public URL) + a task', () => {
  const input = { taskId: 'task-1', computerId: 'computer-a' }
  test('computer-routed spawn must resolve a non-null target', () => {
    expect(resolve(undefined, input)).not.toBeNull()
  })
  test('computerId echoed back', () => {
    expect(resolve(undefined, input)?.computerId).toBe('computer-a')
  })
  test('loopback base on boundPort', () => {
    expect(resolve(undefined, input)?.hubBaseUrl).toBe('http://127.0.0.1:4141')
  })
  test('no bearer field on the resolved env (token plumbing removed)', () => {
    expect(resolve(undefined, input)).not.toHaveProperty('token')
  })
})

// 2. SLAYZONE_HUB_PUBLIC_ADDRESS wins over loopback; the scheme comes from the HOST
//    (A1: a non-loopback host is https), never from the value.
test('public address wins, https from the host', () => {
  expect(resolve('hub.example:8443', { taskId: 'task-3', computerId: 'r' })?.hubBaseUrl).toBe(
    'https://hub.example:8443'
  )
})

// 2a. A LOOPBACK public address (a same-box proxy under test) → http. Proves the
//     scheme tracks the host alone, so it can never disagree with the computer's
//     ws(s) reading of the same hub. A leftover SLAYZONE_MODE moves nothing either way.
test('loopback host → http even with a leftover MODE=remote', () => {
  expect(
    resolve('localhost:8443', { taskId: 'task-3', computerId: 'r' }, 4141, 'remote')?.hubBaseUrl
  ).toBe('http://localhost:8443')
})
test('public host → https even with a leftover MODE=local', () => {
  expect(
    resolve('hub.example:8443', { taskId: 'task-3', computerId: 'r' }, 4141, 'local')?.hubBaseUrl
  ).toBe('https://hub.example:8443')
})

// 2b. A value carrying a SCHEME is malformed now (the channel is authority-only)
//     → null, NOT a silent loopback substitution (the operator asked for a remote
//     base; degrade via the contract).
test('address carrying a scheme → null', () => {
  expect(resolve('https://hub.example:8443', { taskId: 't', computerId: 'r' })).toBeNull()
})

// 2c. A value carrying a PATH is rejected too (no path-prefixed proxy mount).
test('address carrying a path → null', () => {
  expect(resolve('hub.example:8443/slayzone', { taskId: 't', computerId: 'r' })).toBeNull()
})

// 3. Taskless spawn (pooled agent, taskId undefined) → base still resolved.
describe('taskless spawn (pooled agent, taskId undefined)', () => {
  const input = { taskId: undefined, computerId: 'r' }
  test('taskless spawn still resolves a base', () => {
    expect(resolve(undefined, input)).not.toBeNull()
  })
  test('taskless base on boundPort', () => {
    expect(resolve(undefined, input)?.hubBaseUrl).toBe('http://127.0.0.1:4141')
  })
})

// 4. Unresolvable base (port not bound yet, no public URL) → null (→ loopback
//    fallback upstream, never a poisoned/unreachable hub target).
test('no reachable base → null', () => {
  expect(resolve(undefined, { taskId: 'task-5', computerId: 'r' }, 0)).toBeNull()
})

// 5. boundPort read LAZILY: same provider returns null before bind, a real base
//    after — proving the closure reads the port at call time, not at build time.
describe('boundPort read lazily', () => {
  let port = 0
  const provider = createRemoteMcpEnvProvider({ getBoundPort: () => port })
  test('null while port unbound', () => {
    withPublicAddress(undefined, () => {
      expect(provider({ taskId: 't', computerId: 'r' })).toBeNull()
    })
  })
  test('picks up boundPort once set (lazy read)', () => {
    port = 5555
    withPublicAddress(undefined, () => {
      expect(provider({ taskId: 't', computerId: 'r' })?.hubBaseUrl).toBe('http://127.0.0.1:5555')
    })
  })
})
