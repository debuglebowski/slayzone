/**
 * Computer `/computers` URL derivation + the cert-pin seam that remains.
 *
 * `/computers` has no listener of its own — it rides the ONE hub listener, demuxed
 * by path (server.ts), and that listener is always plain http: the hub never
 * terminates TLS. A hub other machines reach sits behind a front end that does, and
 * the join token carries `wss://<public address>/computers` (rule A2) with NO pin.
 *
 * What this exercises:
 *   1. `deriveComputerHubUrl`: no public address → `ws://` loopback on the hub port;
 *      public address → `<ws|wss>://<public-address>/computers` with the scheme from
 *      the HOST (A1), never from a mode; missing/malformed → null.
 *   2. The computer dialer's pin seam, which STAYS until the client-side pin code is
 *      removed: a token minted by an OLDER hub still carries a fingerprint, and a
 *      computer given one must still refuse a certificate that does not match. The
 *      served leaf comes from `@slayzone/hub-identity`, the same helper the old hub
 *      listener used (the hub itself no longer loads it).
 *
 * Pure Node (real https + ws + @peculiar/x509 via hub-identity; no better-sqlite3,
 * so plain `npx tsx`). The full through-`startServer` boot (composeServer →
 * better-auth migrations) is covered by the e2e specs and hub-boot.test.ts.
 *
 * Run with: npx tsx packages/apps/hub/src/computer-tls-listener.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import {
  certMatchesFingerprint,
  certSha256FingerprintFromDer
} from '@slayzone/computer-transport/shared'
import { loadOrCreateHubIdentity } from '@slayzone/hub-identity/server'
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

interface TlsComputerHub {
  https: HttpsServer
  url: string
  fingerprint: string
  close: () => Promise<void>
}

/** Stand up a TLS `/computers` endpoint presenting a self-signed identity leaf — what
 *  an older hub served and what a pinned token still guards against. Only
 *  `/computers` is wired (the pin seam under test). */
async function startTlsComputerHub(dir: string): Promise<TlsComputerHub> {
  const identity = await loadOrCreateHubIdentity(dir)
  const https = createHttpsServer({ key: identity.keyPem, cert: identity.certPem })
  const wss = new WebSocketServer({ noServer: true })
  https.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0]
    if (pathname !== '/computers') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, () => {
      /* server side: keep the socket open; the test only inspects the leaf */
    })
  })
  await new Promise<void>((r) => https.listen(0, '127.0.0.1', r))
  const port = (https.address() as AddressInfo).port
  return {
    https,
    url: deriveComputerHubUrl({ host: '127.0.0.1', port })!.replace('ws://', 'wss://'),
    fingerprint: identity.fingerprintSha256Hex,
    close: async () => {
      wss.close()
      await new Promise<void>((r) => https.close(() => r()))
    }
  }
}

/** Dial + capture the leaf cert seen on the ws 'upgrade' event — the exact point
 *  the computer's hub-dialer enforces its pin. */
function dialAndCaptureLeaf(url: string): Promise<{ der: Uint8Array | null; opened: boolean }> {
  return new Promise((resolve) => {
    let der: Uint8Array | null = null
    let opened = false
    const ws = new WebSocket(url, {
      rejectUnauthorized: false
    } as unknown as WebSocket.ClientOptions)
    ws.on('upgrade', (res) => {
      const cert = (res.socket as TLSSocket).getPeerCertificate()
      der = cert && cert.raw ? cert.raw : null
    })
    const done = (): void => {
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
      resolve({ der, opened })
    }
    ws.on('open', () => {
      opened = true
      done()
    })
    ws.on('error', done)
  })
}

async function main(): Promise<void> {
  console.log('computer /computers URL derivation + the remaining cert-pin seam')

  await test('a pinned token from an older hub: the served identity leaf matches its fingerprint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'computer-tls-listener-'))
    const hub = await startTlsComputerHub(dir)
    try {
      assert(/^wss:\/\/127\.0\.0\.1:\d+\/computers$/.test(hub.url), `wss url shape: ${hub.url}`)
      const { der, opened } = await dialAndCaptureLeaf(hub.url)
      assert(opened, 'wss handshake completed over the https listener')
      assert(der !== null, 'client observed a leaf certificate on the upgrade')
      // The pin carried in the join token (identity.fingerprintSha256Hex) matches
      // the leaf the hub actually serves — end-to-end pinning holds.
      assert(
        certMatchesFingerprint(hub.fingerprint, der as Uint8Array),
        'served leaf fingerprint equals identity.fingerprintSha256Hex'
      )
      assert(
        certSha256FingerprintFromDer(der as Uint8Array) === hub.fingerprint,
        'raw DER sha256 equals the advertised fingerprint'
      )
    } finally {
      await hub.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('a mismatched pin does NOT match the served leaf', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'computer-tls-listener-'))
    const hub = await startTlsComputerHub(dir)
    try {
      const { der } = await dialAndCaptureLeaf(hub.url)
      assert(der !== null, 'leaf present')
      const wrong = (hub.fingerprint[0] === 'a' ? 'b' : 'a') + hub.fingerprint.slice(1)
      assert(
        !certMatchesFingerprint(wrong, der as Uint8Array),
        'a tampered fingerprint is rejected by certMatchesFingerprint'
      )
    } finally {
      await hub.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

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
