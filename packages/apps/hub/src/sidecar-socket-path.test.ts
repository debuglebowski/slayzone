/**
 * resolveSidecarSocketPath — the fork sidecar's Unix-socket path DERIVES from
 * SLAYZONE_ROOT (`<ROOT>/run/sidecar.sock`), the single anchor the C++ shell +
 * JS each compute independently (no extra env var to thread). A very deep ROOT
 * falls back to a short OS-runtime dir (Unix socket path length cap).
 *
 * Pure Node (no native deps).
 */
import { afterEach, beforeEach, expect, test } from 'vitest'
import { resolveSidecarSocketPath } from './sidecar-socket'

const prevRoot = process.env.SLAYZONE_ROOT
const prevXdg = process.env.XDG_RUNTIME_DIR
beforeEach(() => {
  delete process.env.XDG_RUNTIME_DIR
})
afterEach(() => {
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  restore('SLAYZONE_ROOT', prevRoot)
  restore('XDG_RUNTIME_DIR', prevXdg)
})

// Derives <ROOT>/run/sidecar.sock.
test('derives <ROOT>/run/sidecar.sock', () => {
  process.env.SLAYZONE_ROOT = '/srv/slayzone'
  expect(resolveSidecarSocketPath()).toBe('/srv/slayzone/run/sidecar.sock')
})

// A very deep ROOT (> ~104 char socket path) falls back off ROOT.
test('deep ROOT falls back to short runtime dir', () => {
  const root = `/${'x'.repeat(120)}`
  process.env.SLAYZONE_ROOT = root
  process.env.XDG_RUNTIME_DIR = '/run/user/1000'
  const deep = resolveSidecarSocketPath()
  expect(deep.startsWith(root), `got ${deep}`).toBe(false)
  expect(deep).toBe('/run/user/1000/slayzone/sidecar.sock')
})
