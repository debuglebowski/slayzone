import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  randomBytes,
  webcrypto
} from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import * as x509 from '@peculiar/x509'

// Node's WebCrypto, handed explicitly to every @peculiar/x509 call that needs a
// provider. We deliberately do NOT mutate the library-global `x509.cryptoProvider`
// singleton at import time: doing so would rewire a process-wide default as a
// side effect of merely importing this module, making unrelated x509 consumers
// order-dependent.
const cryptoProvider = webcrypto as unknown as Crypto

const IDENTITY_DIR = 'identity'
const KEY_FILE = 'key.pem'
const CERT_FILE = 'cert.pem'
const TMP_SUFFIX = '.tmp'
const FILE_MODE = 0o600
const DIR_MODE = 0o700
const SUBJECT = 'CN=SlayZone Hub'
// The fingerprint is the hub's pinned runner identity — an expiring cert would
// force a silent identity rotation, so make expiry practically unreachable.
const VALIDITY_YEARS = 100

const SIGNING_ALGORITHM: EcKeyGenParams & { hash: string } = {
  name: 'ECDSA',
  namedCurve: 'P-256',
  hash: 'SHA-256'
}

// Loopback SANs so the identity is a usable TLS server certificate (standard
// hostname verification), independent of the fingerprint-pinning path. Peers
// that pin `fingerprintSha256Hex` ignore these; peers doing ordinary TLS
// verification against localhost accept them.
const SAN_NAMES: x509.JsonGeneralName[] = [
  { type: 'dns', value: 'localhost' },
  { type: 'ip', value: '127.0.0.1' }
]

export interface HubIdentity {
  /** PKCS#8 private key, PEM-encoded. */
  keyPem: string
  /** Self-signed leaf certificate, PEM-encoded. */
  certPem: string
  /**
   * Lowercase hex SHA-256 of the leaf certificate DER. This exact digest is
   * what runner peers pin, so its derivation must never change.
   */
  fingerprintSha256Hex: string
  /**
   * True when identity files existed on disk but were unusable (unparseable,
   * partially missing, or key/cert mismatch) and a fresh identity was minted.
   * False on both clean reload and first-ever creation.
   */
  regenerated: boolean
}

type IdentityMaterial = Omit<HubIdentity, 'regenerated'>

/**
 * Load the hub's TLS identity from `<dir>/identity/`, creating it on first run.
 *
 * Reload is stable: the same files yield the same fingerprint across restarts.
 * Corrupted state (unparseable PEM, one file missing, key not matching cert)
 * is replaced with a freshly generated identity and reported via the
 * `regenerated` flag instead of throwing. Genuine I/O faults (EACCES, EIO, …)
 * are surfaced rather than mistaken for "missing" — that distinction is what
 * keeps a transient error from silently rotating the pinned identity.
 */
export async function loadOrCreateHubIdentity(dir: string): Promise<HubIdentity> {
  const identityDir = join(dir, IDENTITY_DIR)
  const keyPath = join(identityDir, KEY_FILE)
  const certPath = join(identityDir, CERT_FILE)

  const keyRaw = readFileOrNull(keyPath)
  const certRaw = readFileOrNull(certPath)
  const hadArtifacts = keyRaw !== null || certRaw !== null

  if (keyRaw !== null && certRaw !== null) {
    const loaded = validateIdentity(keyRaw, certRaw)
    if (loaded) {
      enforceFileMode(keyPath)
      enforceFileMode(certPath)
      return { ...loaded, regenerated: false }
    }
  }

  const fresh = await generateIdentity()
  mkdirSync(identityDir, { recursive: true, mode: DIR_MODE })
  sweepStaleTmp(identityDir)
  writeFileAtomic(keyPath, fresh.keyPem)
  writeFileAtomic(certPath, fresh.certPem)
  fsyncDir(identityDir)
  return { ...fresh, regenerated: hadArtifacts }
}

async function generateIdentity(): Promise<IdentityMaterial> {
  const keys = await webcrypto.subtle.generateKey(SIGNING_ALGORITHM, true, ['sign', 'verify'])

  // Clear the top bit so the DER INTEGER serial is always positive.
  const serial = randomBytes(16)
  serial[0] &= 0x7f

  // Backdate notBefore a day to tolerate clock skew across runner machines.
  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const notAfter = new Date(notBefore)
  notAfter.setFullYear(notAfter.getFullYear() + VALIDITY_YEARS)

  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: serial.toString('hex'),
      name: SUBJECT,
      notBefore,
      notAfter,
      signingAlgorithm: SIGNING_ALGORITHM,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyAgreement,
          true
        ),
        new x509.ExtendedKeyUsageExtension([
          x509.ExtendedKeyUsage.serverAuth,
          x509.ExtendedKeyUsage.clientAuth
        ]),
        new x509.SubjectAlternativeNameExtension(SAN_NAMES),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey, false, cryptoProvider)
      ]
    },
    cryptoProvider
  )

  const keyPem = KeyObject.from(keys.privateKey).export({ type: 'pkcs8', format: 'pem' }) as string
  return {
    keyPem,
    certPem: cert.toString('pem'),
    fingerprintSha256Hex: fingerprintOfCert(cert)
  }
}

function validateIdentity(keyPem: string, certPem: string): IdentityMaterial | null {
  try {
    const cert = new x509.X509Certificate(certPem)
    const privateKey = createPrivateKey(keyPem)
    const spkiFromKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
    if (!spkiFromKey.equals(Buffer.from(cert.publicKey.rawData))) return null
    return { keyPem, certPem, fingerprintSha256Hex: fingerprintOfCert(cert) }
  } catch {
    return null
  }
}

function fingerprintOfCert(cert: x509.X509Certificate): string {
  return createHash('sha256').update(new Uint8Array(cert.rawData)).digest('hex')
}

/**
 * Read a file as UTF-8, mapping only "not found" to null. Any other error
 * (permission, I/O, wrong file type) propagates — a genuine fault must never be
 * mistaken for "no identity yet", which would silently mint a new one.
 */
function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Write-then-rename so a crash mid-write never leaves a truncated PEM behind.
 * The explicit chmod defeats the process umask (which would otherwise mask the
 * open(2) mode and leave the file looser than 0600), and the fsync flushes the
 * bytes to disk before the rename publishes them — so a power loss can't expose
 * a zero-length identity file that would read back as corrupt and regenerate.
 */
function writeFileAtomic(path: string, data: string): void {
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}${TMP_SUFFIX}`
  let fd: number | undefined
  try {
    fd = openSync(tmpPath, 'wx', FILE_MODE)
    writeFileSync(fd, data)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    chmodSync(tmpPath, FILE_MODE)
    renameSync(tmpPath, path)
  } catch (err) {
    if (fd !== undefined) closeFdQuietly(fd)
    rmSync(tmpPath, { force: true })
    throw err
  }
}

/** Best-effort perms healing on reload; never fatal (e.g. read-only mounts). */
function enforceFileMode(path: string): void {
  try {
    chmodSync(path, FILE_MODE)
  } catch {
    // The identity itself loaded fine — tightening perms is advisory.
  }
}

/**
 * fsync the directory so the rename that published key.pem/cert.pem is itself
 * durable. Best-effort: some platforms (notably Windows) reject fsync on a
 * directory handle, which is fine — the file fsyncs already ran.
 */
function fsyncDir(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // Directory fsync unsupported or not permitted; non-fatal.
  } finally {
    if (fd !== undefined) closeFdQuietly(fd)
  }
}

/** Remove leftover *.tmp files (a private key each) from crashed prior writes. */
function sweepStaleTmp(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(TMP_SUFFIX)) rmSync(join(dir, name), { force: true })
    }
  } catch {
    // Sweep is opportunistic hygiene; failure never blocks identity creation.
  }
}

function closeFdQuietly(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    // Already closing down an error path; a failed close is not actionable.
  }
}
