/**
 * Fleet `/fleet` TLS listener + cert-pinning seam (Wave3.5-D2).
 *
 * server.ts stands the fleet WS up on a SEPARATE https listener terminated with
 * the hub identity leaf (loadOrCreateHubIdentity), NOT on the shared http server.
 * A runner pins the leaf's sha256 fingerprint (carried in its join token) on the
 * ws 'upgrade' event before sending any fleet frame (hub-dialer verifyPinnedCert).
 *
 * Covered here (pure Node — real https + ws + @peculiar/x509 via hub-identity; no
 * better-sqlite3 / node:sqlite, so plain `npx tsx`, not the electron strict loader):
 *   1. The REAL identity cert TLS-terminates an https listener AND presents a leaf
 *      whose fingerprint equals `identity.fingerprintSha256Hex` — i.e. the pin the
 *      runner extracts from the token matches the leaf the hub actually serves.
 *   2. A mismatched pin does not match the served leaf.
 *   3. Bind-failure degradation: `startFleetListener` returns null (fleet stays
 *      dark) instead of throwing when its port is already taken, so a fleet-port
 *      conflict can never abort `startServer` / take down the shared http server.
 *   4. `resolveFleetPort` honours a valid SLAYZONE_FLEET_PORT and falls back to 0.
 *
 * The full through-`startServer` boot (composeServer → better-auth migrations) and
 * the fleet-OFF byte-identical boot are covered by the e2e specs, not here.
 *
 * Run with: npx tsx packages/apps/hub/src/fleet-tls-listener.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import WebSocket, { WebSocketServer } from 'ws'
import { certMatchesFingerprint, certSha256FingerprintFromDer } from '@slayzone/fleet/shared'
import { loadOrCreateHubIdentity } from '@slayzone/hub-identity/server'
import { resolveFleetPort, startFleetListener } from './fleet-listener.js'

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

interface TlsFleetHub {
  https: HttpsServer
  url: string
  fingerprint: string
  close: () => Promise<void>
}

/** Stand up the D2 listener shape via the SAME `startFleetListener` server.ts uses:
 *  an https server (hub identity leaf) whose `/fleet` upgrades go to a noServer
 *  WSS — exactly server.ts's fleet branch. */
async function startTlsFleetHub(dir: string): Promise<TlsFleetHub> {
  const identity = await loadOrCreateHubIdentity(dir)
  const https = createHttpsServer({ key: identity.keyPem, cert: identity.certPem })
  const wss = new WebSocketServer({ noServer: true })
  https.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '').split('?')[0]
    if (pathname !== '/fleet') {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, () => {
      /* server side: keep the socket open; the test only inspects the leaf */
    })
  })
  const info = await startFleetListener({
    server: https,
    host: '127.0.0.1',
    fingerprintSha256Hex: identity.fingerprintSha256Hex
  })
  assert(info !== null, 'fleet listener bound on a free port')
  return {
    https,
    url: info.hubUrl,
    fingerprint: info.certFingerprint,
    close: async () => {
      wss.close()
      await new Promise<void>((r) => https.close(() => r()))
    }
  }
}

/** Dial + capture the leaf cert seen on the ws 'upgrade' event — the exact point
 *  the runner's hub-dialer enforces its pin. */
function dialAndCaptureLeaf(url: string): Promise<{ der: Uint8Array | null; opened: boolean }> {
  return new Promise((resolve) => {
    let der: Uint8Array | null = null
    let opened = false
    const ws = new WebSocket(url, { rejectUnauthorized: false } as unknown as WebSocket.ClientOptions)
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

/** Grab a bound-and-held TCP port so a subsequent listen on it fails EADDRINUSE. */
async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const blocker = createNetServer()
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
  const port = (blocker.address() as AddressInfo).port
  return {
    port,
    release: () => new Promise<void>((r) => blocker.close(() => r()))
  }
}

async function main(): Promise<void> {
  console.log('fleet /fleet TLS listener + pin seam')

  await test('hub identity cert TLS-terminates the /fleet listener and its fingerprint is the pinned leaf', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-tls-listener-'))
    const hub = await startTlsFleetHub(dir)
    try {
      assert(/^wss:\/\/127\.0\.0\.1:\d+\/fleet$/.test(hub.url), `wss url shape: ${hub.url}`)
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
    const dir = mkdtempSync(join(tmpdir(), 'fleet-tls-listener-'))
    const hub = await startTlsFleetHub(dir)
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

  await test('bind failure on a taken port degrades to null (fleet dark) instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-tls-listener-'))
    const identity = await loadOrCreateHubIdentity(dir)
    const occupied = await occupyPort()
    const https = createHttpsServer({ key: identity.keyPem, cert: identity.certPem })
    let bindError: Error | null = null
    try {
      const info = await startFleetListener({
        server: https,
        host: '127.0.0.1',
        fingerprintSha256Hex: identity.fingerprintSha256Hex,
        fleetPortEnv: String(occupied.port), // already held → EADDRINUSE
        onBindFailure: (e) => {
          bindError = e
        }
      })
      assert(info === null, 'startFleetListener returned null on bind failure (did not throw)')
      assert(bindError !== null, 'onBindFailure was invoked with the bind error')
      // The failed https server must be closed — not left half-open. A fresh listen
      // on port 0 must succeed (proves the object is reusable / not wedged).
      await new Promise<void>((r) => https.listen(0, '127.0.0.1', r))
      assert(https.listening, 'the https server rebinds cleanly after the failed bind was closed')
    } finally {
      await new Promise<void>((r) => https.close(() => r()))
      await occupied.release()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await test('resolveFleetPort honours a valid override and falls back to 0', async () => {
    assert(resolveFleetPort('51099') === 51099, 'valid port passes through')
    assert(resolveFleetPort(undefined) === 0, 'unset → 0 (OS-assigned)')
    assert(resolveFleetPort('') === 0, 'empty → 0')
    assert(resolveFleetPort('not-a-port') === 0, 'non-numeric → 0')
    assert(resolveFleetPort('70000') === 0, 'out-of-range → 0')
    assert(resolveFleetPort('-1') === 0, 'negative → 0')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
