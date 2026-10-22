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
 * Pure function, no boot (plain `npx tsx`). The full through-`startServer` boot
 * (composeServer → better-auth migrations) is covered by the e2e specs and
 * hub-boot.test.ts.
 *
 * Run with: npx tsx packages/apps/hub/src/computer-tls-listener.test.ts
 */
import { deriveComputerHubUrl } from './computer-listener.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    failed++
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

async function main(): Promise<void> {
  console.log('computer /computers URL derivation')

  await test('deriveComputerHubUrl: no public address → ws:// loopback on the hub port', async () => {
    assert(
      deriveComputerHubUrl({ host: '127.0.0.1', port: 51101 }) === 'ws://127.0.0.1:51101/computers',
      'loopback ws url'
    )
    // A wildcard bind host goes into the token as a dialable loopback, never 0.0.0.0.
    assert(
      deriveComputerHubUrl({ host: '0.0.0.0', port: 51101 }) === 'ws://127.0.0.1:51101/computers',
      'wildcard bind → loopback in the token'
    )
    assert(
      deriveComputerHubUrl({ host: '127.0.0.1', port: 51101, publicAddress: '   ' }) ===
        'ws://127.0.0.1:51101/computers',
      'a blank public address is the same as none'
    )
  })

  await test('deriveComputerHubUrl: public address → wss:// for a non-loopback host (A1/A2)', async () => {
    assert(
      deriveComputerHubUrl({
        host: '0.0.0.0',
        port: 51101,
        publicAddress: 'hub.example:8443'
      }) === 'wss://hub.example:8443/computers',
      'explicit port preserved'
    )
    assert(
      deriveComputerHubUrl({ host: '0.0.0.0', port: 51101, publicAddress: 'hub.example' }) ===
        'wss://hub.example/computers',
      'bare host keeps the implicit TLS port (443)'
    )
    assert(
      deriveComputerHubUrl({
        host: '0.0.0.0',
        port: 51101,
        publicAddress: '[2001:db8::1]:9000'
      }) === 'wss://[2001:db8::1]:9000/computers',
      'bracketed IPv6 authority'
    )
    // The public address is what the token carries even when the hub itself binds
    // loopback behind a same-box reverse proxy (B13).
    assert(
      deriveComputerHubUrl({ host: '127.0.0.1', port: 51101, publicAddress: 'hub.example' }) ===
        'wss://hub.example/computers',
      'loopback bind + public address → the public address wins'
    )
  })

  await test('deriveComputerHubUrl: a loopback PUBLIC address is ws:// — the scheme follows the host', async () => {
    assert(
      deriveComputerHubUrl({ host: '127.0.0.1', port: 51101, publicAddress: 'localhost:8443' }) ===
        'ws://localhost:8443/computers',
      'same-box proxy under test is plaintext'
    )
  })

  await test('deriveComputerHubUrl: a leftover SLAYZONE_MODE changes nothing', async () => {
    const prev = process.env.SLAYZONE_MODE
    process.env.SLAYZONE_MODE = 'remote'
    try {
      assert(
        deriveComputerHubUrl({ host: '127.0.0.1', port: 51101 }) ===
          'ws://127.0.0.1:51101/computers',
        'remote does not secure a loopback hub'
      )
    } finally {
      if (prev === undefined) delete process.env.SLAYZONE_MODE
      else process.env.SLAYZONE_MODE = prev
    }
  })

  await test('deriveComputerHubUrl: a non-authority public address → null', async () => {
    assert(
      deriveComputerHubUrl({ host: '0.0.0.0', port: 51101, publicAddress: 'not an address' }) ===
        null,
      'malformed public address → null'
    )
    // The whole point of the authority-only channel: a scheme is NOT accepted, so no
    // reader can ever disagree with the scheme derived from the host.
    assert(
      deriveComputerHubUrl({
        host: '0.0.0.0',
        port: 51101,
        publicAddress: 'https://hub.example'
      }) === null,
      'a full url (scheme present) → null'
    )
    assert(
      deriveComputerHubUrl({
        host: '0.0.0.0',
        port: 51101,
        publicAddress: 'hub.example/computers'
      }) === null,
      'a path → null'
    )
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
