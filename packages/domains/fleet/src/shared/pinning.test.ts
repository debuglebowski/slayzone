import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  certMatchesFingerprint,
  certSha256Fingerprint,
  certSha256FingerprintFromDer,
  normalizeCertSha256Fingerprint
} from './pinning'

/** Generate a throwaway self-signed cert with the system openssl. */
function generateSelfSignedCert(dir: string): { certPem: string; keyPath: string; certPath: string } {
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost'],
    { stdio: 'pipe' }
  )
  return { certPem: readFileSync(certPath, 'utf8'), keyPath, certPath }
}

let dir: string
let certPem: string
let certPath: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-pin-'))
  const generated = generateSelfSignedCert(dir)
  certPem = generated.certPem
  certPath = generated.certPath
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('certSha256Fingerprint', () => {
  it('matches the fingerprint openssl computes for the same cert', () => {
    // Independent oracle: `openssl x509 -fingerprint -sha256` prints
    // `sha256 Fingerprint=AB:CD:...`.
    const opensslOut = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256'], {
      encoding: 'utf8'
    })
    const expected = opensslOut.split('=')[1]!.trim().replaceAll(':', '').toLowerCase()
    expect(expected).toMatch(/^[0-9a-f]{64}$/)
    expect(certSha256Fingerprint(certPem)).toBe(expected)
  })

  it('is lowercase hex sha256 of the DER, identical across PEM / DER / X509Certificate inputs', () => {
    const x509 = new X509Certificate(certPem)
    const fromPem = certSha256Fingerprint(certPem)
    const fromDer = certSha256FingerprintFromDer(x509.raw)
    const fromX509 = certSha256Fingerprint(x509)
    expect(fromPem).toMatch(/^[0-9a-f]{64}$/)
    expect(fromDer).toBe(fromPem)
    expect(fromX509).toBe(fromPem)
  })
})

describe('normalizeCertSha256Fingerprint', () => {
  it('strips colons and lowercases', () => {
    const fp = certSha256Fingerprint(certPem)
    const colonized = fp
      .toUpperCase()
      .match(/.{2}/g)!
      .join(':')
    expect(normalizeCertSha256Fingerprint(colonized)).toBe(fp)
  })

  it('rejects non-fingerprint input', () => {
    expect(() => normalizeCertSha256Fingerprint('nope')).toThrow(/invalid sha256/)
    expect(() => normalizeCertSha256Fingerprint('zz'.repeat(32))).toThrow(/invalid sha256/)
  })
})

describe('certMatchesFingerprint', () => {
  it('accepts the right pin in any formatting and rejects a wrong one', () => {
    const der = new X509Certificate(certPem).raw
    const fp = certSha256FingerprintFromDer(der)
    expect(certMatchesFingerprint(fp, der)).toBe(true)
    expect(certMatchesFingerprint(fp.toUpperCase(), der)).toBe(true)
    const wrong = (fp[0] === 'a' ? 'b' : 'a') + fp.slice(1)
    expect(certMatchesFingerprint(wrong, der)).toBe(false)
  })
})
