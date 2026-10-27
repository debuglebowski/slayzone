/**
 * Computer `/computers` URL derivation.
 *
 * `/computers` has no listener of its own — it rides the ONE hub listener, demuxed
 * by path (server.ts), and that listener is always plain http: the hub never
 * terminates TLS. A hub other machines reach sits behind a front end that does, and
 * the join token carries `wss://<public address>/computers` (rule A2) with NO pin.
 * Enrolling through such a front end, with its certificate verified the normal way,
 * is tls-front-end.test.ts.
 *
 * What this exercises — `deriveComputerHubUrl`: no public address → `ws://` loopback
 * on the hub port; public address → `<ws|wss>://<public-address>/computers` with the
 * scheme from the HOST (A1), never from a mode; missing/malformed → null.
 *
 * Pure function, no boot. The full through-`startServer` boot
 * (composeServer → better-auth migrations) is covered by the e2e specs and
 * hub-boot.test.ts.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { expect, test } from 'vitest'
import { deriveComputerHubUrl } from './computer-listener.js'

test('deriveComputerHubUrl: no public address → ws:// loopback on the hub port', async () => {
  expect(deriveComputerHubUrl({ host: '127.0.0.1', port: 51101 }), 'loopback ws url').toBe(
    'ws://127.0.0.1:51101/computers'
  )
  // A wildcard bind host goes into the token as a dialable loopback, never 0.0.0.0.
  expect(
    deriveComputerHubUrl({ host: '0.0.0.0', port: 51101 }),
    'wildcard bind → loopback in the token'
  ).toBe('ws://127.0.0.1:51101/computers')
  expect(
    deriveComputerHubUrl({ host: '127.0.0.1', port: 51101, publicAddress: '   ' }),
    'a blank public address is the same as none'
  ).toBe('ws://127.0.0.1:51101/computers')
})

test('deriveComputerHubUrl: public address → wss:// for a non-loopback host (A1/A2)', async () => {
  expect(
    deriveComputerHubUrl({ host: '0.0.0.0', port: 51101, publicAddress: 'hub.example:8443' }),
    'explicit port preserved'
  ).toBe('wss://hub.example:8443/computers')
  expect(
    deriveComputerHubUrl({ host: '0.0.0.0', port: 51101, publicAddress: 'hub.example' }),
    'bare host keeps the implicit TLS port (443)'
  ).toBe('wss://hub.example/computers')
  expect(
    deriveComputerHubUrl({ host: '0.0.0.0', port: 51101, publicAddress: '[2001:db8::1]:9000' }),
    'bracketed IPv6 authority'
  ).toBe('wss://[2001:db8::1]:9000/computers')
  // The public address is what the token carries even when the hub itself binds
  // loopback behind a same-box reverse proxy (B13).
  expect(
    deriveComputerHubUrl({ host: '127.0.0.1', port: 51101, publicAddress: 'hub.example' }),
    'loopback bind + public address → the public address wins'
  ).toBe('wss://hub.example/computers')
})

test('deriveComputerHubUrl: a loopback PUBLIC address is ws:// — the scheme follows the host', async () => {
  expect(
    deriveComputerHubUrl({ host: '127.0.0.1', port: 51101, publicAddress: 'localhost:8443' }),
    'same-box proxy under test is plaintext'
  ).toBe('ws://localhost:8443/computers')
})

test('deriveComputerHubUrl: a leftover SLAYZONE_MODE changes nothing', async () => {
  const prev = process.env.SLAYZONE_MODE
  process.env.SLAYZONE_MODE = 'remote'
  try {
    expect(
      deriveComputerHubUrl({ host: '127.0.0.1', port: 51101 }),
      'remote does not secure a loopback hub'
    ).toBe('ws://127.0.0.1:51101/computers')
  } finally {
    if (prev === undefined) delete process.env.SLAYZONE_MODE
    else process.env.SLAYZONE_MODE = prev
  }
})

test('deriveComputerHubUrl: a non-authority public address → null', async () => {
  expect(
    deriveComputerHubUrl({ host: '0.0.0.0', port: 51101, publicAddress: 'not an address' }),
    'malformed public address → null'
  ).toBeNull()
  // The whole point of the authority-only channel: a scheme is NOT accepted, so no
  // reader can ever disagree with the scheme derived from the host.
  expect(
    deriveComputerHubUrl({ host: '0.0.0.0', port: 51101, publicAddress: 'https://hub.example' }),
    'a full url (scheme present) → null'
  ).toBeNull()
  expect(
    deriveComputerHubUrl({ host: '0.0.0.0', port: 51101, publicAddress: 'hub.example/computers' }),
    'a path → null'
  ).toBeNull()
})
