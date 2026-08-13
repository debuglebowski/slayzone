import type { ComputerCredentialStore } from '@slayzone/computer-transport/client'
import { ComputerTransportErrorCodes, RpcError } from '@slayzone/computer-transport/shared'
import { describe, expect, it, vi } from 'vitest'
import type { ComputerConfig } from './config'
import type { ComputerDialer } from './handlers/types'
import { createHubRequestHandler, startComputer } from './main'

const fakeDialer: ComputerDialer = { notify: () => true }

const testConfig: ComputerConfig = {
  hubUrl: 'ws://localhost:0/computers',
  name: 'test-computer',
  allowedRoots: ['/tmp'],
  capabilities: ['pty', 'git', 'fs', 'proc']
}

/** A credential store that never touches disk (keeps startComputer unit-safe). */
function memoryStore(): ComputerCredentialStore {
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
  // Names inside the reserved namespaces that this computer does NOT implement.
  // `fs.readFile` used to sit here and stopped qualifying once the file-editor
  // ops were routed — an unimplemented-method fixture has to be a method that
  // stays unimplemented, or the test quietly starts asserting a zod parse error.
  it.each([
    'fs.chmod',
    'git.clone',
    'proc.status',
    'bogus.method'
  ])('answers unknown method %s with -32001 unimplemented', async (method) => {
    const { handle } = makeDispatch()
    const err = await handle(method, {}).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).code).toBe(ComputerTransportErrorCodes.unimplemented)
    expect((err as RpcError).message).toBe(`unimplemented: ${method}`)
  })

  it('routes implemented methods (git.isGitRepo does not throw unimplemented)', async () => {
    const { handle } = makeDispatch()
    // /tmp is inside allowedRoots but not a git repo → resolves to
    // { isGitRepo: false } (the key the SHARED result schema declares; this test
    // used to assert the computer's own divergent `isRepo`).
    const result = await handle('git.isGitRepo', { path: '/tmp' })
    expect(result).toEqual({ isGitRepo: false })
  })

  it('acks computer.shutdown and then triggers the shutdown callback', async () => {
    const shutdown = vi.fn()
    const { handle } = makeDispatch(shutdown)
    const pending = handle('computer.shutdown', { reason: 'maintenance' })
    expect(shutdown).not.toHaveBeenCalled() // ack built before shutdown fires…
    const result = await pending
    expect(result).toEqual({ ok: true })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(shutdown).toHaveBeenCalledWith('maintenance') // …stop after the ack resolves
  })

  it('defaults the shutdown reason', async () => {
    const shutdown = vi.fn()
    const { handle } = makeDispatch(shutdown)
    await handle('computer.shutdown', undefined)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(shutdown).toHaveBeenCalledWith('hub-requested')
  })

  it('dispose() is callable with no live sessions', () => {
    const { dispose } = makeDispatch()
    expect(() => dispose()).not.toThrow()
  })
})

describe('startComputer cert-pin guard', () => {
  // Loopback port 0 keeps these hermetic: startComputer calls dialer.start() (a real
  // outbound connect attempt), so a routable/public-looking host would do real
  // network I/O. 127.0.0.1:0 fails fast + unref'd → no hang, no external traffic.
  it('feeds the pin to the dialer on a wss:// hub url (constructor accepts it)', async () => {
    const handle = startComputer(
      {
        ...testConfig,
        hubUrl: 'wss://127.0.0.1:0/computers',
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
    // A pin reaching startComputer on a ws:// url can only be the join-token-decoded
    // fingerprint (an EXPLICIT env/file pin on ws:// already fails in loadComputerConfig).
    // The guard must strip it so a ws token stays usable for loopback/dev — without
    // it the HubDialer constructor throws "pinnedCertSha256 requires a wss:// hub url".
    let handle: ReturnType<typeof startComputer> | null = null
    expect(() => {
      handle = startComputer(
        {
          ...testConfig,
          hubUrl: 'ws://127.0.0.1:0/computers',
          pinnedCertSha256: 'a'.repeat(64)
        },
        { credentialStore: memoryStore() }
      )
    }).not.toThrow()
    if (handle) await (handle as ReturnType<typeof startComputer>).stop()
  })
})

describe('startComputer multi-hub', () => {
  // Loopback port 0 keeps this hermetic — startComputer calls dialer.start(), so a
  // routable host would do real network I/O. See the note above.
  it('opens one dialer per configured hub, and only one by default', async () => {
    const single = startComputer(testConfig, { credentialStore: memoryStore() })
    try {
      expect(single.dialers.length).toBe(1)
      // The named `dialer` stays the primary, because a computer serving exactly
      // one hub is the overwhelming case and every existing caller reads it.
      expect(single.dialer).toBe(single.dialers[0])
    } finally {
      await single.stop()
    }

    const multi = startComputer(
      {
        ...testConfig,
        hubUrls: ['ws://127.0.0.1:0/computers', 'ws://127.0.0.2:0/computers']
      },
      { credentialStore: memoryStore() }
    )
    try {
      expect(multi.dialers.length).toBe(2)
      // Independent connections, not one dialer reused — each hub has its own
      // credentials, its own project-path map and its own agent-hook relay.
      expect(multi.dialers[0]).not.toBe(multi.dialers[1])
    } finally {
      await multi.stop()
    }
  })

  // The same hub twice would mean two dialers racing over one credential entry.
  it('de-duplicates repeated hub urls', async () => {
    const handle = startComputer(
      {
        ...testConfig,
        hubUrls: ['ws://127.0.0.1:0/computers', 'ws://127.0.0.1:0/computers']
      },
      { credentialStore: memoryStore() }
    )
    try {
      expect(handle.dialers.length).toBe(1)
    } finally {
      await handle.stop()
    }
  })
})
