/**
 * resolveSidecarSocketPath — the fork sidecar's Unix-socket path DERIVES from
 * SLAYZONE_ROOT (`<ROOT>/run/sidecar.sock`), the single anchor the C++ shell +
 * JS each compute independently (no extra env var to thread). A very deep ROOT
 * falls back to a short OS-runtime dir (Unix socket path length cap).
 *
 * Pure Node (no native deps) → runs under plain `npx tsx`.
 */
import { resolveSidecarSocketPath } from './sidecar-socket'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}

const prevRoot = process.env.SLAYZONE_ROOT
const prevXdg = process.env.XDG_RUNTIME_DIR
try {
  delete process.env.XDG_RUNTIME_DIR

  // Derives <ROOT>/run/sidecar.sock.
  process.env.SLAYZONE_ROOT = '/srv/slayzone'
  check(
    'derives <ROOT>/run/sidecar.sock',
    resolveSidecarSocketPath() === '/srv/slayzone/run/sidecar.sock',
    `got ${resolveSidecarSocketPath()}`
  )

  // A very deep ROOT (> ~104 char socket path) falls back off ROOT.
  process.env.SLAYZONE_ROOT = '/' + 'x'.repeat(120)
  process.env.XDG_RUNTIME_DIR = '/run/user/1000'
  const deep = resolveSidecarSocketPath()
  check(
    'deep ROOT falls back to short runtime dir',
    !deep.startsWith(process.env.SLAYZONE_ROOT) && deep === '/run/user/1000/slayzone/sidecar.sock',
    `got ${deep}`
  )
} finally {
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  restore('SLAYZONE_ROOT', prevRoot)
  restore('XDG_RUNTIME_DIR', prevXdg)
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
