/**
 * The computer's WebRTC runtime for the direct link (docs/direct-link.md):
 * node-datachannel (libdatachannel: OpenSSL DTLS, usrsctp, libjuice ICE).
 *
 * Loaded lazily and optional, never at import (like node-pty). It ships Node-API
 * prebuilds as per-platform optional packages (macOS, Linux gnu/musl, Windows; x64
 * and arm64), so the same binary loads under plain Node and under Electron's Node.
 * Where none fits, this answers null and the computer does not offer WebRTC: clients
 * use the hub relay, as before. A failure is not cached: a later call retries.
 *
 * @module computer/direct/rtc-runtime
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

export type RtcRuntime = typeof import('node-datachannel')

let loaded: RtcRuntime | undefined

/** node-datachannel, or null when it cannot load on this machine. */
export function loadRtcRuntime(log?: (message: string, detail: object) => void): RtcRuntime | null {
  if (loaded) return loaded
  try {
    loaded =
      typeof require === 'function'
        ? // The computer's CJS bundle: esbuild leaves this call in place, external.
          (require('node-datachannel') as RtcRuntime)
        : // Unbundled ESM (tests): resolve from the entry script.
          (createRequire(process.argv[1] ?? join(process.cwd(), 'index.js'))(
            'node-datachannel'
          ) as RtcRuntime)
    return loaded
  } catch (err) {
    log?.('WebRTC unavailable on this computer — clients use the hub relay', {
      error: String(err)
    })
    return null
  }
}
