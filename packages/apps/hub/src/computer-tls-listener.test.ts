/**
 * Computer `/computers` cert-pinning seam + URL derivation (single-listener model).
 *
 * `/computers` no longer has its own listener — it rides the ONE hub listener,
 * demuxed by path (server.ts). In remote mode that listener terminates TLS with
 * the hub identity leaf (loadOrCreateHubIdentity), so a computer still pins the
 * leaf's sha256 fingerprint (carried in its join token) on the ws 'upgrade' event
 * before sending any computer frame (hub-dialer verifyPinnedCert). This test proves
 * the pin seam still holds on the SHARED listener, and that `deriveComputerHubUrl`
 * emits the right `ws(s)://…/computers` URL per mode.
 *
 * Pure Node (real https + ws + @peculiar/x509 via hub-identity; no better-sqlite3,
 * so plain `npx tsx`):
 *   1. The REAL identity cert TLS-terminates the shared listener AND presents a
 *      leaf whose fingerprint equals `identity.fingerprintSha256Hex` — the pin the
 *      computer extracts from the token matches the leaf the hub actually serves.
 *   2. A mismatched pin does not match the served leaf.
 *   3. `deriveComputerHubUrl`: local → `ws://` loopback; remote → `wss://` from the
 *      public URL; missing/malformed remote public URL → null.
 *
 * The full through-`startServer` boot (composeServer → better-auth migrations) is
 * covered by the e2e specs, not here.
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

/** Stand up the SHARED-listener shape server.ts uses in remote mode: one https
 *  server (hub identity leaf) whose `/trpc` + `/computers` upgrades are demuxed to
 *  noServer WSS handlers — here we only wire `/computers` (the pin seam under test). */
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
    url: deriveComputerHubUrl({ remote: false, host: '127.0.0.1', port })!.replace(
      'ws://',
      'wss://'
    ),
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
  console.log('computer /computers cert-pin seam (shared listener) + URL derivation')

  await test('hub identity cert TLS-terminates the shared listener and its fingerprint is the pinned leaf', async () => {
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

  await test('deriveComputerHubUrl: local → ws:// loopback on the hub port', async () => {
    assert(
      deriveComputerHubUrl({ remote: false, host: '127.0.0.1', port: 51101 }) ===
        'ws://127.0.0.1:51101/computers',
      'local loopback ws url'
    )
    // A wildcard bind host goes into the token as a dialable loopback, never 0.0.0.0.
    assert(
      deriveComputerHubUrl({ remote: false, host: '0.0.0.0', port: 51101 }) ===
        'ws://127.0.0.1:51101/computers',
      'wildcard bind → loopback in the token'
    )
  })

  await test('deriveComputerHubUrl: remote → wss:// from the public ADDRESS (authority only)', async () => {
    assert(
      deriveComputerHubUrl({
        remote: true,
        host: '0.0.0.0',
        port: 51101,
        publicAddress: 'hub.example:8443'
      }) === 'wss://hub.example:8443/computers',
      'explicit port preserved'
    )
    assert(
      deriveComputerHubUrl({
        remote: true,
        host: '0.0.0.0',
        port: 51101,
        publicAddress: 'hub.example'
      }) === 'wss://hub.example/computers',
      'bare host keeps the implicit TLS port (443)'
    )
    assert(
      deriveComputerHubUrl({
        remote: true,
        host: '0.0.0.0',
        port: 51101,
        publicAddress: '[2001:db8::1]:9000'
      }) === 'wss://[2001:db8::1]:9000/computers',
      'bracketed IPv6 authority'
    )
  })

  await test('deriveComputerHubUrl: remote with missing/non-authority public address → null', async () => {
    assert(
      deriveComputerHubUrl({
        remote: true,
        host: '0.0.0.0',
        port: 51101,
        publicAddress: undefined
      }) === null,
      'unset public address → null'
    )
    assert(
      deriveComputerHubUrl({ remote: true, host: '0.0.0.0', port: 51101, publicAddress: '   ' }) ===
        null,
      'blank public address → null'
    )
    assert(
      deriveComputerHubUrl({
        remote: true,
        host: '0.0.0.0',
        port: 51101,
        publicAddress: 'not an address'
      }) === null,
      'malformed public address → null'
    )
    // The whole point of the authority-only channel: a scheme is NOT accepted, so
    // no reader can ever disagree with the one derived from SLAYZONE_MODE.
    assert(
      deriveComputerHubUrl({
        remote: true,
        host: '0.0.0.0',
        port: 51101,
        publicAddress: 'https://hub.example'
      }) === null,
      'a full url (scheme present) → null'
    )
    assert(
      deriveComputerHubUrl({
        remote: true,
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
