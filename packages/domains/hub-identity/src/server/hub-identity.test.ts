import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecureContext } from 'node:tls'
import * as x509 from '@peculiar/x509'
import { afterEach, describe, expect, it } from 'vitest'
import { loadOrCreateHubIdentity } from './index'

const FINGERPRINT_RE = /^[0-9a-f]{64}$/
const onPosix = process.platform !== 'win32'

const tempDirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hub-identity-'))
  tempDirs.push(dir)
  return dir
}

function keyPath(dir: string): string {
  return join(dir, 'identity', 'key.pem')
}

function certPath(dir: string): string {
  return join(dir, 'identity', 'cert.pem')
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777
}

/** Independent DER extraction: strip PEM armor, base64-decode the body. */
function pemToDer(pem: string): Buffer {
  const body = pem.replace(/-----(?:BEGIN|END) [^-]+-----/g, '').replace(/\s+/g, '')
  return Buffer.from(body, 'base64')
}

afterEach(() => {
  // Drain one at a time so a single failed rmSync can't strand the rest.
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup; a locked temp dir shouldn't fail the suite.
    }
  }
})

describe('loadOrCreateHubIdentity', () => {
  it('creates a fresh identity on first run', async () => {
    const dir = makeDir()
    const identity = await loadOrCreateHubIdentity(dir)

    expect(identity.regenerated).toBe(false)
    expect(identity.keyPem).toContain('BEGIN PRIVATE KEY')
    expect(identity.certPem).toContain('BEGIN CERTIFICATE')
    expect(identity.fingerprintSha256Hex).toMatch(FINGERPRINT_RE)
    expect(readFileSync(keyPath(dir), 'utf8')).toBe(identity.keyPem)
    expect(readFileSync(certPath(dir), 'utf8')).toBe(identity.certPem)
  })

  it('produces material accepted by the Node TLS stack', async () => {
    const dir = makeDir()
    const identity = await loadOrCreateHubIdentity(dir)

    expect(() =>
      createSecureContext({ key: identity.keyPem, cert: identity.certPem })
    ).not.toThrow()
  })

  it('embeds loopback SANs for standard TLS verification', async () => {
    const dir = makeDir()
    const { certPem } = await loadOrCreateHubIdentity(dir)

    const cert = new x509.X509Certificate(certPem)
    const san = cert.getExtension(x509.SubjectAlternativeNameExtension)
    expect(san).not.toBeNull()
    const values = san?.names.items.map((n) => n.value) ?? []
    expect(values).toContain('localhost')
    expect(values).toContain('127.0.0.1')
  })

  it('fingerprint is the lowercase hex SHA-256 of the certificate DER', async () => {
    const dir = makeDir()
    const identity = await loadOrCreateHubIdentity(dir)

    const expected = createHash('sha256').update(pemToDer(identity.certPem)).digest('hex')
    expect(identity.fingerprintSha256Hex).toBe(expected)
  })

  it('reloads the same identity with a stable fingerprint', async () => {
    const dir = makeDir()
    const first = await loadOrCreateHubIdentity(dir)
    const second = await loadOrCreateHubIdentity(dir)

    expect(second.regenerated).toBe(false)
    expect(second.fingerprintSha256Hex).toBe(first.fingerprintSha256Hex)
    expect(second.certPem).toBe(first.certPem)
    expect(second.keyPem).toBe(first.keyPem)
  })

  it.runIf(onPosix)('persists key and cert with 0600 perms', async () => {
    const dir = makeDir()
    await loadOrCreateHubIdentity(dir)

    expect(fileMode(keyPath(dir))).toBe(0o600)
    expect(fileMode(certPath(dir))).toBe(0o600)
  })

  it.runIf(onPosix)('forces 0600 even under a permissive umask', async () => {
    const prev = process.umask(0o022)
    try {
      const dir = makeDir()
      await loadOrCreateHubIdentity(dir)
      expect(fileMode(keyPath(dir))).toBe(0o600)
      expect(fileMode(certPath(dir))).toBe(0o600)
    } finally {
      process.umask(prev)
    }
  })

  it.runIf(onPosix)('re-tightens loosened perms on reload', async () => {
    const dir = makeDir()
    await loadOrCreateHubIdentity(dir)
    chmodSync(keyPath(dir), 0o644)
    chmodSync(certPath(dir), 0o644)

    const reloaded = await loadOrCreateHubIdentity(dir)
    expect(reloaded.regenerated).toBe(false)
    expect(fileMode(keyPath(dir))).toBe(0o600)
    expect(fileMode(certPath(dir))).toBe(0o600)
  })

  it('regenerates when the certificate file is truncated', async () => {
    const dir = makeDir()
    const first = await loadOrCreateHubIdentity(dir)
    writeFileSync(certPath(dir), first.certPem.slice(0, 40))

    const second = await loadOrCreateHubIdentity(dir)
    expect(second.regenerated).toBe(true)
    expect(second.fingerprintSha256Hex).toMatch(FINGERPRINT_RE)
    expect(second.fingerprintSha256Hex).not.toBe(first.fingerprintSha256Hex)

    const third = await loadOrCreateHubIdentity(dir)
    expect(third.regenerated).toBe(false)
    expect(third.fingerprintSha256Hex).toBe(second.fingerprintSha256Hex)
  })

  it('regenerates when the key file is corrupted', async () => {
    const dir = makeDir()
    const first = await loadOrCreateHubIdentity(dir)
    writeFileSync(keyPath(dir), 'not a pem at all')

    const second = await loadOrCreateHubIdentity(dir)
    expect(second.regenerated).toBe(true)
    expect(second.fingerprintSha256Hex).not.toBe(first.fingerprintSha256Hex)
  })

  it('regenerates a matched pair when one identity file is missing', async () => {
    const dir = makeDir()
    await loadOrCreateHubIdentity(dir)
    rmSync(keyPath(dir))

    const second = await loadOrCreateHubIdentity(dir)
    expect(second.regenerated).toBe(true)
    expect(readFileSync(keyPath(dir), 'utf8')).toBe(second.keyPem)
    // The surviving file must also be rewritten so the on-disk pair matches.
    expect(readFileSync(certPath(dir), 'utf8')).toBe(second.certPem)

    const third = await loadOrCreateHubIdentity(dir)
    expect(third.regenerated).toBe(false)
    expect(third.fingerprintSha256Hex).toBe(second.fingerprintSha256Hex)
  })

  it('regenerates when the key does not match the certificate', async () => {
    const dirA = makeDir()
    const dirB = makeDir()
    await loadOrCreateHubIdentity(dirA)
    const b = await loadOrCreateHubIdentity(dirB)
    copyFileSync(keyPath(dirA), keyPath(dirB))

    const second = await loadOrCreateHubIdentity(dirB)
    expect(second.regenerated).toBe(true)
    expect(second.fingerprintSha256Hex).not.toBe(b.fingerprintSha256Hex)
  })

  it.runIf(onPosix)('regenerated files are rewritten with 0600 perms', async () => {
    const dir = makeDir()
    await loadOrCreateHubIdentity(dir)
    writeFileSync(certPath(dir), 'garbage')
    chmodSync(certPath(dir), 0o644)

    const second = await loadOrCreateHubIdentity(dir)
    expect(second.regenerated).toBe(true)
    expect(fileMode(keyPath(dir))).toBe(0o600)
    expect(fileMode(certPath(dir))).toBe(0o600)
  })
})
