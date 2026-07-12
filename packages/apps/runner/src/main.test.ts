import type { RunnerCredentialStore } from '@slayzone/fleet/client'
import { FleetErrorCodes, RpcError } from '@slayzone/fleet/shared'
import { describe, expect, it, vi } from 'vitest'
import type { RunnerConfig } from './config'
import type { RunnerDialer } from './handlers/types'
import { createHubRequestHandler, startRunner } from './main'

const fakeDialer: RunnerDialer = { notify: () => true }

const testConfig: RunnerConfig = {
  hubUrl: 'ws://localhost:0/fleet',
  name: 'test-runner',
  allowedRoots: ['/tmp'],
  capabilities: ['pty', 'git', 'fs', 'proc']
}

/** A credential store that never touches disk (keeps startRunner unit-safe). */
function memoryStore(): RunnerCredentialStore {
  return {
    load: async () => null,
    save: async () => {},
    clear: async () => {},
    filePath: '/dev/null'
  }
}

function makeDispatch(shutdown: (reason: string) => void = () => {}) {
  return createHubRequestHandler({ shutdown, dialer: fakeDialer, config: testConfig })
}

describe('createHubRequestHandler dispatch table', () => {
  it.each(['fs.readFile', 'git.clone', 'proc.status', 'bogus.method'])(
    'answers unknown method %s with -32001 unimplemented',
    async (method) => {
      const { handle } = makeDispatch()
      const err = await handle(method, {}).then(
        () => null,
        (e: unknown) => e
      )
      expect(err).toBeInstanceOf(RpcError)
      expect((err as RpcError).code).toBe(FleetErrorCodes.unimplemented)
      expect((err as RpcError).message).toBe(`unimplemented: ${method}`)
    }
  )

  it('routes implemented methods (git.isGitRepo does not throw unimplemented)', async () => {
    const { handle } = makeDispatch()
    // /tmp is inside allowedRoots but not a git repo → resolves to { isRepo: false }.
    const result = await handle('git.isGitRepo', { path: '/tmp' })
    expect(result).toEqual({ isRepo: false })
  })

  it('acks runner.shutdown and then triggers the shutdown callback', async () => {
    const shutdown = vi.fn()
    const { handle } = makeDispatch(shutdown)
    const pending = handle('runner.shutdown', { reason: 'maintenance' })
    expect(shutdown).not.toHaveBeenCalled() // ack built before shutdown fires…
    const result = await pending
    expect(result).toEqual({ ok: true })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(shutdown).toHaveBeenCalledWith('maintenance') // …stop after the ack resolves
  })

  it('defaults the shutdown reason', async () => {
    const shutdown = vi.fn()
    const { handle } = makeDispatch(shutdown)
    await handle('runner.shutdown', undefined)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(shutdown).toHaveBeenCalledWith('hub-requested')
  })

  it('dispose() is callable with no live sessions', () => {
    const { dispose } = makeDispatch()
    expect(() => dispose()).not.toThrow()
  })
})

describe('startRunner cert-pin guard', () => {
  // Loopback port 0 keeps these hermetic: startRunner calls dialer.start() (a real
  // outbound connect attempt), so a routable/public-looking host would do real
  // network I/O. 127.0.0.1:0 fails fast + unref'd → no hang, no external traffic.
  it('feeds the pin to the dialer on a wss:// hub url (constructor accepts it)', async () => {
    const handle = startRunner(
      {
        ...testConfig,
        hubUrl: 'wss://127.0.0.1:0/fleet',
        pinnedCertSha256: 'a'.repeat(64)
      },
      { credentialStore: memoryStore() }
    )
    try {
      // The HubDialer constructor did not throw for a pin on wss:// → pin was fed
      // through (it throws "pinnedCertSha256 requires a wss:// hub url" otherwise).
      expect(handle.dialer).toBeDefined()
    } finally {
      await handle.stop()
    }
  })

  it('does NOT throw when a token-decoded pin lands on a ws:// hub url (guard drops it)', async () => {
    // A pin reaching startRunner on a ws:// url can only be the join-token-decoded
    // fingerprint (an EXPLICIT env/file pin on ws:// already fails in loadRunnerConfig).
    // The guard must strip it so a ws token stays usable for loopback/dev — without
    // it the HubDialer constructor throws "pinnedCertSha256 requires a wss:// hub url".
    let handle: ReturnType<typeof startRunner> | null = null
    expect(() => {
      handle = startRunner(
        {
          ...testConfig,
          hubUrl: 'ws://127.0.0.1:0/fleet',
          pinnedCertSha256: 'a'.repeat(64)
        },
        { credentialStore: memoryStore() }
      )
    }).not.toThrow()
    if (handle) await (handle as ReturnType<typeof startRunner>).stop()
  })
})
