/**
 * A throwaway certificate authority for tests that stand up a TLS front end.
 *
 * A hub never terminates TLS: a front end does, and every client (computer, CLI,
 * desktop) verifies its certificate the normal way — CA chain + hostname, nothing
 * pinned. A test reproduces exactly that: it mints its own CA, issues leaf
 * certificates from it, and makes the CLIENT trust the CA through the normal path —
 * `NODE_EXTRA_CA_CERTS` for a child process, {@link trustTestCaInThisProcess} (Node's
 * default CA store) for the test process itself. Never a "skip verification" switch
 * in product code.
 *
 * Uses the `openssl` CLI (present on every CI runner and dev box), driven by explicit
 * config files so it behaves the same on OpenSSL 1.1/3.x/4.x and LibreSSL.
 */
import { execFileSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'

export interface TestLeaf {
  certPem: string
  keyPem: string
}

export interface TestCa {
  /** The CA certificate, PEM. */
  caPem: string
  /** Path of the CA certificate on disk — what `NODE_EXTRA_CA_CERTS` points at. */
  caPath: string
  /** Issue a server certificate signed by this CA. Defaults to `localhost` + `127.0.0.1`. */
  issueLeaf: (opts?: { dnsNames?: string[]; ips?: string[] }) => TestLeaf
  /** Remove the CA's files. */
  cleanup: () => void
}

/** Run `openssl` in `cwd`. `args` is space-separated: every file name here is ours,
 *  relative to `cwd` and space-free. */
function openssl(args: string, cwd: string): void {
  execFileSync('openssl', args.split(' '), { cwd, stdio: 'pipe' })
}

/** Mint a fresh CA (valid two days) in its own temp dir. */
export function createTestCa(label = 'SlayZone Test CA'): TestCa {
  const dir = mkdtempSync(join(tmpdir(), 'slz-test-ca-'))
  writeFileSync(
    join(dir, 'ca.cnf'),
    [
      '[req]',
      'distinguished_name = dn',
      'prompt = no',
      'x509_extensions = v3_ca',
      '[dn]',
      `CN = ${label}`,
      '[v3_ca]',
      'basicConstraints = critical,CA:TRUE',
      'keyUsage = critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier = hash',
      ''
    ].join('\n')
  )
  openssl(
    'req -x509 -new -nodes -newkey rsa:2048 -keyout ca.key -out ca.pem -days 2 -config ca.cnf',
    dir
  )
  const caPath = join(dir, 'ca.pem')
  let leaves = 0

  return {
    caPem: readFileSync(caPath, 'utf8'),
    caPath,
    issueLeaf: (opts = {}) => {
      const n = ++leaves
      const dnsNames = opts.dnsNames ?? ['localhost']
      const ips = opts.ips ?? ['127.0.0.1']
      const san = [...dnsNames.map((d) => `DNS:${d}`), ...ips.map((ip) => `IP:${ip}`)].join(',')
      writeFileSync(
        join(dir, `leaf${n}.cnf`),
        [
          '[req]',
          'distinguished_name = dn',
          'prompt = no',
          '[dn]',
          `CN = ${dnsNames[0] ?? ips[0]}`,
          ''
        ].join('\n')
      )
      writeFileSync(
        join(dir, `leaf${n}.ext`),
        [
          'basicConstraints = critical,CA:FALSE',
          'keyUsage = critical,digitalSignature,keyEncipherment',
          'extendedKeyUsage = serverAuth',
          `subjectAltName = ${san}`,
          'subjectKeyIdentifier = hash',
          'authorityKeyIdentifier = keyid',
          ''
        ].join('\n')
      )
      openssl(
        `req -new -nodes -newkey rsa:2048 -keyout leaf${n}.key -out leaf${n}.csr -config leaf${n}.cnf`,
        dir
      )
      const serial = randomInt(1, 2 ** 47)
      openssl(
        `x509 -req -in leaf${n}.csr -CA ca.pem -CAkey ca.key -set_serial ${serial} -days 2 -out leaf${n}.pem -extfile leaf${n}.ext`,
        dir
      )
      return {
        certPem: readFileSync(join(dir, `leaf${n}.pem`), 'utf8'),
        keyPem: readFileSync(join(dir, `leaf${n}.key`), 'utf8')
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Add `caPem` to THIS process's default CA store — the store every TLS client in
 * the process (https, fetch, ws) uses when it passes no `ca` of its own. The
 * in-process equivalent of `NODE_EXTRA_CA_CERTS`. Returns a restore function.
 */
export function trustTestCaInThisProcess(caPem: string): () => void {
  const before = getCACertificates('default')
  setDefaultCACertificates([...before, caPem])
  return () => setDefaultCACertificates(before)
}
