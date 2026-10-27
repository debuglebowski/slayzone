/**
 * computer.config.json — loadComputerConfigFile / save / update, plus the legacy
 * shared config.json fallback. Pure Node (real temp files, no native deps) →
 * runs under plain `npx tsx`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/computer-config-file.test.ts
 */
import { describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getComputerConfigFilePath,
  ignoredComputerConfigKeys,
  loadComputerConfigFile,
  saveComputerConfigFile,
  updateComputerConfigFile
} from './slayzone-config'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'slz-computercfg-'))
}

describe('computer-config-file: loadComputerConfigFile', () => {
  test('missing file ⇒ {} (no throw)', () => {
    const dir = tmp()
    try {
      const cfg = loadComputerConfigFile(join(dir, 'nope.json'))
      expect(Object.keys(cfg).length, 'empty config').toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('corrupt JSON ⇒ {} + warns to stderr (no throw)', () => {
    const dir = tmp()
    const p = join(dir, 'computer.config.json')
    writeFileSync(p, '{not valid json')
    const orig = process.stderr.write.bind(process.stderr)
    let warned = ''
    ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      warned += s
      return true
    }
    try {
      const cfg = loadComputerConfigFile(p)
      expect(Object.keys(cfg).length, 'empty config on corrupt').toBe(0)
      expect(warned, 'warned about invalid JSON').toMatch(/not valid JSON/)
    } finally {
      ;(process.stderr as unknown as { write: typeof orig }).write = orig
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('non-object JSON (array) ⇒ {} + warns', () => {
    const dir = tmp()
    const p = join(dir, 'computer.config.json')
    writeFileSync(p, '[1,2,3]')
    const orig = process.stderr.write.bind(process.stderr)
    let warned = ''
    ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      warned += s
      return true
    }
    try {
      const cfg = loadComputerConfigFile(p)
      expect(Object.keys(cfg).length, 'empty on array').toBe(0)
      expect(warned, 'warned about non-object').toMatch(/not a JSON object/)
    } finally {
      ;(process.stderr as unknown as { write: typeof orig }).write = orig
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('valid config parses all known keys, drops wrong types', () => {
    const dir = tmp()
    const p = join(dir, 'computer.config.json')
    writeFileSync(
      p,
      JSON.stringify({
        joinToken: 'jt-1',
        computerName: 'r1',
        hubUrl: 'wss://hub/computers',
        allowedRoots: ['/srv/a', '/srv/b'],
        // wrong-typed / unknown → dropped
        joinToken2: 'nope',
        extra: { nested: 1 }
      })
    )
    const cfg = loadComputerConfigFile(p)
    expect(cfg.joinToken, 'joinToken').toBe('jt-1')
    expect(cfg.computerName, 'computerName').toBe('r1')
    expect(cfg.hubUrl, 'hubUrl').toBe('wss://hub/computers')
    expect(JSON.stringify(cfg.allowedRoots), 'allowedRoots').toBe(
      JSON.stringify(['/srv/a', '/srv/b'])
    )
    expect(cfg, 'unknown key dropped').not.toHaveProperty('extra')
    rmSync(dir, { recursive: true, force: true })
  })

  test('wrong-typed values are dropped (empty joinToken/hubUrl, non-array allowedRoots)', () => {
    const dir = tmp()
    const p = join(dir, 'computer.config.json')
    writeFileSync(
      p,
      JSON.stringify({
        joinToken: '',
        hubUrl: '',
        allowedRoots: 'not-an-array'
      })
    )
    const cfg = loadComputerConfigFile(p)
    expect(cfg.joinToken, 'empty joinToken dropped').toBeUndefined()
    expect(cfg.hubUrl, 'empty hubUrl dropped').toBeUndefined()
    expect(cfg.allowedRoots, 'non-array allowedRoots dropped').toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a certificate pin from an older release is ignored, and reported as such', () => {
    // `pinnedCertSha256` pinned the certificate an older hub served itself. The rest of
    // the file still loads; the key is never coerced, but ignoredComputerConfigKeys
    // names it so the computer can say it ignores it.
    const dir = tmp()
    const p = join(dir, 'computer.config.json')
    writeFileSync(
      p,
      JSON.stringify({
        hubUrl: 'wss://hub/computers',
        joinToken: 'jt-1',
        pinnedCertSha256: 'a'.repeat(64)
      })
    )
    const cfg = loadComputerConfigFile(p)
    expect(cfg.hubUrl, 'the rest of the file still loads').toBe('wss://hub/computers')
    expect(cfg, 'the pin is never coerced').not.toHaveProperty('pinnedCertSha256')
    expect(JSON.stringify(ignoredComputerConfigKeys(p)), 'pin reported').toBe(
      '["pinnedCertSha256"]'
    )

    // The next write drops it from disk (update re-coerces the current file).
    updateComputerConfigFile({ computerName: 'r1' }, p)
    expect(readFileSync(p, 'utf8'), 'gone after the next write').not.toContain('pinnedCertSha256')
    expect(ignoredComputerConfigKeys(p).length, 'nothing left to report').toBe(0)

    // Read through the legacy config.json fallback too, same as loadComputerConfigFile.
    const legacyDir = tmp()
    writeFileSync(
      join(legacyDir, 'config.json'),
      JSON.stringify({ pinnedCertSha256: 'b'.repeat(64) })
    )
    expect(
      JSON.stringify(ignoredComputerConfigKeys(join(legacyDir, 'computer.config.json'))),
      'legacy file pin reported'
    ).toBe('["pinnedCertSha256"]')
    const emptyDir = tmp()
    expect(
      ignoredComputerConfigKeys(join(emptyDir, 'computer.config.json')).length,
      'no file'
    ).toBe(0)
    for (const d of [dir, legacyDir, emptyDir]) rmSync(d, { recursive: true, force: true })
  })

  test('allowedRoots filters out non-string / empty entries, keeps a non-empty result', () => {
    const dir = tmp()
    const p = join(dir, 'computer.config.json')
    writeFileSync(p, JSON.stringify({ allowedRoots: ['/ok', '', 42, '/also-ok'] }))
    const cfg = loadComputerConfigFile(p)
    expect(JSON.stringify(cfg.allowedRoots), 'filtered array').toBe(
      JSON.stringify(['/ok', '/also-ok'])
    )
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('computer-config-file: save / update round-trip', () => {
  test('save then load round-trips + file is 0600, dir 0700 (POSIX)', () => {
    const dir = tmp()
    const p = join(dir, 'sub', 'computer.config.json')
    saveComputerConfigFile({ hubUrl: 'wss://a/computers', computerName: 'r1' }, p)
    const back = loadComputerConfigFile(p)
    expect(back.hubUrl, 'hubUrl round-trip').toBe('wss://a/computers')
    expect(back.computerName, 'computerName round-trip').toBe('r1')
    if (process.platform !== 'win32') {
      expect(statSync(p).mode & 0o777, 'file mode 0600').toBe(0o600)
      expect(statSync(join(dir, 'sub')).mode & 0o777, 'dir mode 0700').toBe(0o700)
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test('updateComputerConfigFile merges over on-disk base (no clobber of other keys)', () => {
    const dir = tmp()
    const p = join(dir, 'computer.config.json')
    saveComputerConfigFile({ hubUrl: 'wss://a/computers' }, p)
    const merged = updateComputerConfigFile({ joinToken: 'jt-2' }, p)
    expect(merged.hubUrl, 'kept hubUrl').toBe('wss://a/computers')
    expect(merged.joinToken, 'added joinToken').toBe('jt-2')
    const onDisk = loadComputerConfigFile(p)
    expect(onDisk.joinToken, 'persisted').toBe('jt-2')
    expect(onDisk.hubUrl, 'persisted hubUrl').toBe('wss://a/computers')
    rmSync(dir, { recursive: true, force: true })
  })

  test('update ignores undefined patch values (does not erase)', () => {
    const dir = tmp()
    const p = join(dir, 'computer.config.json')
    saveComputerConfigFile({ hubUrl: 'wss://a/computers' }, p)
    const merged = updateComputerConfigFile({ hubUrl: undefined, computerName: 'r2' }, p)
    expect(merged.hubUrl, 'undefined did not erase hubUrl').toBe('wss://a/computers')
    expect(merged.computerName, 'added computerName').toBe('r2')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('computer-config-file: SLAYZONE_ROOT honored', () => {
  test('getComputerConfigFilePath resolves under SLAYZONE_ROOT', () => {
    const dir = tmp()
    const prev = process.env.SLAYZONE_ROOT
    process.env.SLAYZONE_ROOT = dir
    try {
      expect(getComputerConfigFilePath(), 'path under root override').toBe(
        join(dir, 'computer.config.json')
      )
      saveComputerConfigFile({ computerName: 'r1' })
      const raw = readFileSync(join(dir, 'computer.config.json'), 'utf8')
      expect(raw, 'wrote to the overridden root dir').toMatch(/r1/)
      expect(loadComputerConfigFile().computerName, 'default-path load reads the override').toBe(
        'r1'
      )
    } finally {
      if (prev === undefined) delete process.env.SLAYZONE_ROOT
      else process.env.SLAYZONE_ROOT = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('computer-config-file: legacy shared config.json fallback', () => {
  test('computer.config.json absent, legacy config.json present ⇒ computer keys coerced from it', () => {
    const dir = tmp()
    const legacyPath = join(dir, 'config.json')
    writeFileSync(
      legacyPath,
      JSON.stringify({ joinToken: 'legacy-jt', hubUrl: 'wss://legacy/computers' })
    )
    const cfgPath = join(dir, 'computer.config.json')
    const cfg = loadComputerConfigFile(cfgPath)
    expect(cfg.joinToken, 'joinToken from legacy file').toBe('legacy-jt')
    expect(cfg.hubUrl, 'hubUrl from legacy file').toBe('wss://legacy/computers')
    expect(
      existsSync(cfgPath),
      'never auto-upgrades — computer.config.json not created by a read'
    ).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('new file present takes priority over the legacy file even if both exist', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ computerName: 'from-legacy' }))
    const cfgPath = join(dir, 'computer.config.json')
    saveComputerConfigFile({ computerName: 'from-new' }, cfgPath)
    expect(loadComputerConfigFile(cfgPath).computerName, 'new file wins once it exists').toBe(
      'from-new'
    )
    rmSync(dir, { recursive: true, force: true })
  })
})
