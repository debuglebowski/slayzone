/**
 * node-pty's native loader must report WHY its native did not load (#165).
 *
 * `loadNativeModule` tries `build/Release`, `build/Debug`, then
 * `prebuilds/<platform>-<arch>` and used to throw with only the LAST attempt's
 * error. On Linux there is no prebuild, so a `build/Release/pty.node` that exists
 * but cannot be dlopened (built against a newer glibc: "version `GLIBC_2.42' not
 * found") was reported as "Cannot find module ./prebuilds/linux-x64/pty.node" —
 * the one directory that was never going to exist. The computer requires node-pty
 * at load, so that line is the only cause it can print before it dies.
 *
 * Driven against the INSTALLED (patched) loader, copied beside a native that exists
 * but cannot be loaded, so the dlopen error is whatever this platform says.
 */
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const nodePtyDir = path.dirname(require.resolve('node-pty/package.json'))

let tmp: string | null = null
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = null
})

/** A node-pty layout whose `build/Release/pty.node` exists but is not a loadable native. */
function brokenNativeLayout(): { loadNativeModule: (name: string) => unknown; native: string } {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pty-load-error-'))
  fs.mkdirSync(path.join(tmp, 'lib'))
  fs.copyFileSync(path.join(nodePtyDir, 'lib', 'utils.js'), path.join(tmp, 'lib', 'utils.js'))
  const native = path.join(tmp, 'build', 'Release', 'pty.node')
  fs.mkdirSync(path.dirname(native), { recursive: true })
  fs.writeFileSync(native, 'not a shared object')
  return { loadNativeModule: require(path.join(tmp, 'lib', 'utils.js')).loadNativeModule, native }
}

describe('node-pty loadNativeModule', () => {
  it('reports the dlopen error of a native that exists, not the last directory it tried', () => {
    const { loadNativeModule, native } = brokenNativeLayout()
    let dlopenError = ''
    try {
      require(native)
    } catch (err) {
      dlopenError = (err as Error).message
    }
    expect(dlopenError).not.toBe('')

    let message = ''
    try {
      loadNativeModule('pty')
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain(dlopenError)
    expect(message).toContain('build/Release/pty.node')
  })

  it('still says what it looked for when no native exists anywhere', () => {
    const { loadNativeModule, native } = brokenNativeLayout()
    fs.rmSync(native)
    expect(() => loadNativeModule('pty')).toThrow(/pty\.node.*not found in/)
  })
})
