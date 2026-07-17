/**
 * Certificate pinning spec for the runner transport.
 *
 * A runner that dials a hub over wss may pin the hub's TLS identity instead
 * of relying on a CA chain (hubs typically present self-signed certs). The
 * pin is the **lowercase hex SHA-256 digest of the server leaf certificate in
 * DER encoding** — the same value OpenSSL prints via
 * `openssl x509 -fingerprint -sha256` (minus colons, lowercased).
 *
 * @module runner/shared/pinning
 */

import { createHash, X509Certificate } from 'node:crypto'

/** 64 lowercase hex chars — sha256 of the leaf cert DER. */
export type CertSha256Fingerprint = string

const FINGERPRINT_RE = /^[0-9a-f]{64}$/

/**
 * Normalize a user-supplied fingerprint: strips colons/whitespace, lowercases.
 * Throws if the result is not a 64-char hex string.
 */
export function normalizeCertSha256Fingerprint(input: string): CertSha256Fingerprint {
  const normalized = input.replace(/[:\s]/g, '').toLowerCase()
  if (!FINGERPRINT_RE.test(normalized)) {
    throw new Error(`invalid sha256 certificate fingerprint: '${input}'`)
  }
  return normalized
}

/** Compute the pin from raw DER bytes of a certificate. */
export function certSha256FingerprintFromDer(der: Uint8Array): CertSha256Fingerprint {
  return createHash('sha256').update(der).digest('hex')
}

/**
 * Compute the pin from a PEM string, DER bytes, or an `X509Certificate`.
 * PEM input may contain a full chain; the first (leaf) certificate is used.
 */
export function certSha256Fingerprint(
  cert: string | Uint8Array | X509Certificate
): CertSha256Fingerprint {
  if (cert instanceof X509Certificate) return certSha256FingerprintFromDer(cert.raw)
  if (typeof cert === 'string') return certSha256FingerprintFromDer(new X509Certificate(cert).raw)
  return certSha256FingerprintFromDer(cert)
}

/** Constant-shape comparison of an expected pin against a presented cert DER. */
export function certMatchesFingerprint(
  expected: string,
  presentedDer: Uint8Array
): boolean {
  return normalizeCertSha256Fingerprint(expected) === certSha256FingerprintFromDer(presentedDer)
}
