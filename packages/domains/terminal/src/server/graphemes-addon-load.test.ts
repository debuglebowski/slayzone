/**
 * `@xterm/addon-unicode-graphemes` must load on plain Node no matter what the process
 * allocated first.
 *
 * Its width tables are a base64 literal decoded with `Buffer.from(…, 'base64')`. On
 * Node that buffer is a slice of the shared allocation pool, so `byteOffset` is
 * usually not 0 — and the decoder read the header via `new DataView(e.buffer)`,
 * ignoring the offset. It then inflated garbage: an endless loop (a standalone
 * computer, which loads the addon through the terminal reply mirror, froze at boot)
 * or "Data error". `node:https` loaded first is enough to shift the pool.
 *
 * Fixed at the source by `patches/@xterm__addon-unicode-graphemes@….patch`. Each
 * case runs in a fresh process because a hung load can't be recovered in-process.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const addonPath = require.resolve('@xterm/addon-unicode-graphemes')

function loadAfter(prelude: string): { ok: boolean; detail: string } {
  const script = `${prelude}; const m = require(${JSON.stringify(addonPath)}); if (typeof m.UnicodeGraphemesAddon !== 'function') throw new Error('no addon export'); process.stdout.write('loaded')`
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15_000 })
  return {
    ok: r.status === 0 && r.stdout === 'loaded',
    detail: `status=${r.status} signal=${r.signal} stderr=${(r.stderr ?? '').slice(0, 300)}`
  }
}

test.each([
  ['nothing allocated first', ''],
  ['node:https loaded first', "require('node:https')"],
  ['pool shifted by a small allocation', "Buffer.from('x'.repeat(37))"],
  ['pool shifted by an odd allocation', "Buffer.allocUnsafe(13); Buffer.from('ab')"]
])('the graphemes addon loads on plain Node: %s', (_name, prelude) => {
  const r = loadAfter(prelude)
  expect(r.ok, r.detail).toBe(true)
})
