/**
 * A headless Chromium on a bare Linux box dies before speaking CDP when a system
 * library is absent; the dynamic loader names the first one on stderr. The hint turns
 * that into the install command instead of a wall of loader output.
 */
import { describe, expect, test } from 'vitest'
import { missingLibraryHint, missingSharedLibrary } from './missing-libs'

describe('missingSharedLibrary', () => {
  test('parses the glibc loader message', () => {
    const stderr =
      '/home/u/.cache/slayzone/chrome-headless-shell/157/chrome-headless-shell-linux64/chrome-headless-shell: ' +
      'error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory\n'
    expect(missingSharedLibrary(stderr)).toBe('libnss3.so')
  })

  test('versioned sonames', () => {
    expect(
      missingSharedLibrary(
        'chrome: error while loading shared libraries: libatk-bridge-2.0.so.0: cannot open shared object file'
      )
    ).toBe('libatk-bridge-2.0.so.0')
  })

  test('anything else → null', () => {
    expect(missingSharedLibrary('[1104/120000.1:ERROR:gpu_init.cc] something')).toBeNull()
    expect(missingSharedLibrary('')).toBeNull()
  })
})

describe('missingLibraryHint', () => {
  test('names the library, its Debian package, and the full headless-Chromium set', () => {
    const hint = missingLibraryHint('libnss3.so')
    expect(hint).toContain('libnss3.so')
    expect(hint).toMatch(/sudo apt-get install -y [^\n]*libnss3/)
    for (const pkg of ['libatk-bridge2.0-0', 'libgbm1', 'libxkbcommon0']) {
      expect(hint).toContain(pkg)
    }
    expect(hint).toContain('--browser')
  })

  test('the package that provides an unlisted soname is named generically', () => {
    const hint = missingLibraryHint('libweird.so.9')
    expect(hint).toContain('libweird.so.9')
    expect(hint).toContain('sudo apt-get install -y')
  })

  test('a library outside the standard set is added to the command', () => {
    expect(missingLibraryHint('libasound.so.2')).toMatch(/apt-get install -y [^\n]*libasound2/)
  })
})
