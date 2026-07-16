import { createHash } from 'node:crypto'
import { describe, expect, it, beforeEach } from 'vitest'
import {
  hostKeyFromUrl,
  setPinnedHubs,
  installHubCertPinning,
  _resetHubCertPinningForTest
} from './hub-cert-pinning'

// Minimal PEM for a DER we control, so we can compute its expected fingerprint.
function pemFor(der: Buffer): string {
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----`
}
function fp(der: Buffer): string {
  return createHash('sha256').update(der).digest('hex')
}

// Fake Electron session capturing the installed verify proc.
type VerifyProc = (
  req: { hostname: string; certificate: { data: string }; verificationResult: string; errorCode: number },
  cb: (v: number) => void
) => void
function fakeSession(): { session: { setCertificateVerifyProc: (p: VerifyProc) => void }; run: (req: Parameters<VerifyProc>[0]) => number } {
  let proc: VerifyProc | null = null
  return {
    session: { setCertificateVerifyProc: (p) => (proc = p) },
    run: (req) => {
      let result = 999
      proc?.(req, (v) => (result = v))
      return result
    }
  }
}

describe('hub-cert-pinning', () => {
  beforeEach(() => _resetHubCertPinningForTest())

  it('hostKeyFromUrl extracts the hostname', () => {
    expect(hostKeyFromUrl('wss://box.lan:7800/trpc')).toBe('box.lan')
    expect(hostKeyFromUrl('https://hub.example.com/trpc')).toBe('hub.example.com')
    expect(hostKeyFromUrl('not a url')).toBeNull()
  })

  it('defers to Chromium (-3) for an unpinned host', () => {
    const f = fakeSession()
    installHubCertPinning(f.session as never)
    const der = Buffer.from('some-cert')
    const v = f.run({
      hostname: 'random.example.com',
      certificate: { data: pemFor(der) },
      verificationResult: 'net::OK',
      errorCode: 0
    })
    expect(v).toBe(-3)
  })

  it('accepts (0) a pinned host whose leaf fingerprint matches', () => {
    const der = Buffer.from('pinned-cert-der')
    setPinnedHubs([{ url: 'wss://box.lan:7800/trpc', kind: 'remote' as const, fingerprint: fp(der) }])
    const f = fakeSession()
    installHubCertPinning(f.session as never)
    const v = f.run({
      hostname: 'box.lan',
      certificate: { data: pemFor(der) },
      verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID', // self-signed — overridden by pin
      errorCode: -202
    })
    expect(v).toBe(0)
  })

  it('rejects (-2) a pinned host presenting a DIFFERENT leaf', () => {
    const pinnedDer = Buffer.from('the-real-cert')
    const attackerDer = Buffer.from('mitm-cert')
    setPinnedHubs([
      { url: 'wss://box.lan:7800/trpc', kind: 'remote' as const, fingerprint: fp(pinnedDer) }
    ])
    const f = fakeSession()
    installHubCertPinning(f.session as never)
    const v = f.run({
      hostname: 'box.lan',
      certificate: { data: pemFor(attackerDer) },
      verificationResult: 'net::OK',
      errorCode: 0
    })
    expect(v).toBe(-2)
  })

  it('normalizes fingerprints (colons / uppercase) before comparing', () => {
    const der = Buffer.from('cert-x')
    const hex = fp(der)
    const colonized = hex.toUpperCase().match(/.{2}/g)!.join(':')
    setPinnedHubs([{ url: 'wss://box.lan/trpc', kind: 'remote' as const, fingerprint: colonized }])
    const f = fakeSession()
    installHubCertPinning(f.session as never)
    expect(
      f.run({
        hostname: 'box.lan',
        certificate: { data: pemFor(der) },
        verificationResult: 'net::OK',
        errorCode: 0
      })
    ).toBe(0)
  })
})
