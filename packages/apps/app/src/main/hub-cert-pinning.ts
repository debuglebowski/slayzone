import type { Session } from 'electron'
import { createHash } from 'node:crypto'

/**
 * Multi-hub federation — renderer→remote-hub wss cert pinning (main process).
 *
 * The renderer's WebSocket has no cert hook, so pinning MUST happen in main.
 * `session.setCertificateVerifyProc` sees the TLS cert of every request the
 * renderer's net stack makes; we compare the leaf's sha256 against the pinned
 * fingerprint for that hub host (from the boot-config hub registry). TOFU: a hub
 * whose fingerprint isn't yet known is accepted on first sight and recorded by
 * the caller (Hubs UI / registry), enforced thereafter.
 *
 * Scoping discipline (critical — the verify proc is session-wide):
 *  - Only hosts that appear in the pinned map are subject to pin enforcement.
 *  - Every other host defers to Chromium's own verdict (`verificationResult`),
 *    so loopback/dev/CDN/OAuth traffic is untouched — byte-identical when no
 *    remote hubs are configured (empty map → always defer).
 */

/** hostname → pinned leaf sha256 (lowercase hex, no colons). Electron's
 *  setCertificateVerifyProc is per-host (no port), so we key by hostname. */
type PinMap = Map<string, string>

let pinned: PinMap = new Map()
let installed = false

/** Normalize a fingerprint to lowercase hex without separators. */
function normalizeFingerprint(fp: string): string {
  return fp.replace(/[^a-fA-F0-9]/g, '').toLowerCase()
}

/** hostname key from a hub ws(s) url. */
export function hostKeyFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/** Test-only: allow re-installing the verify proc on a fresh fake session. */
export function _resetHubCertPinningForTest(): void {
  installed = false
  pinned = new Map()
}

/**
 * Replace the pinned-hub set. Called on boot + whenever the registry changes.
 * Entries with no fingerprint are omitted (TOFU — not yet pinned).
 */
export function setPinnedHubs(hubs: Array<{ url?: string; fingerprint?: string }>): void {
  const next: PinMap = new Map()
  for (const h of hubs) {
    if (!h.url || !h.fingerprint) continue
    const key = hostKeyFromUrl(h.url)
    if (key) next.set(key, normalizeFingerprint(h.fingerprint))
  }
  pinned = next
}

/**
 * Install the verify proc ONCE on the given session. Idempotent. Compares the
 * presented leaf's sha256 against the pin for that host; defers to Chromium for
 * any unpinned host.
 *
 * Electron's `request.data` is the PEM of the leaf; hash its DER. We derive DER
 * from the PEM base64 body (the cert is self-signed, so `errorCode`/verification
 * result from Chromium will be a name/authority error we intentionally override
 * ONLY for a matching pin).
 */
export function installHubCertPinning(sess: Session): void {
  if (installed) return
  installed = true
  sess.setCertificateVerifyProc((request, callback) => {
    const expected = pinned.get(request.hostname)
    if (!expected) {
      // Not a pinned hub host → use Chromium's own verdict (0 = use default).
      callback(-3)
      return
    }
    const actual = fingerprintOfPem(request.certificate.data)
    if (actual && actual === expected) {
      callback(0) // pin matches → accept (overrides self-signed authority error)
      return
    }
    callback(-2) // pin mismatch → hard reject
  })
}

/** sha256 (lowercase hex) of a PEM cert's DER, or null if unparseable. */
function fingerprintOfPem(pem: string): string | null {
  const m = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/)
  if (!m) return null
  try {
    const der = Buffer.from(m[1].replace(/\s+/g, ''), 'base64')
    return createHash('sha256').update(der).digest('hex')
  } catch {
    return null
  }
}
