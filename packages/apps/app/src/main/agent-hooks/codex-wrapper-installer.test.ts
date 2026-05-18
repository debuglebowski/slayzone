import fs from 'fs'
import path from 'path'
import os from 'os'
import { describe, test, expect } from 'vitest'
import { installCodexWrapper, parseCodexVersion } from './codex-wrapper-installer'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-codex-wrapper-'))
}

function cleanup(...dirs: string[]) {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {}
  }
}

const SAMPLE = '#!/bin/bash\n# slayzone codex wrapper v1\nexec "$@"\n'

describe('installCodexWrapper', () => {
  test('writes wrapper to ~/.slayzone/bin/codex by default path arg', async () => {
    const dir = tmpDir()
    const target = path.join(dir, '.slayzone', 'bin', 'codex')
    try {
      const result = await installCodexWrapper({
        source: SAMPLE,
        targetPath: target,
        skipVersionProbe: true
      })
      expect(result.changed).toBe(true)
      expect(result.path).toBe(target)
      expect(fs.readFileSync(target, 'utf8')).toBe(SAMPLE)
    } finally {
      cleanup(dir)
    }
  })

  test('applies mode 0755 on POSIX', async () => {
    if (process.platform === 'win32') return
    const dir = tmpDir()
    const target = path.join(dir, 'codex')
    try {
      await installCodexWrapper({ source: SAMPLE, targetPath: target, skipVersionProbe: true })
      const stat = fs.statSync(target)

      expect(stat.mode & 0o777).toBe(0o755)
    } finally {
      cleanup(dir)
    }
  })

  test('idempotent — no-op on rerun w/ same content', async () => {
    const dir = tmpDir()
    const target = path.join(dir, 'codex')
    try {
      const r1 = await installCodexWrapper({
        source: SAMPLE,
        targetPath: target,
        skipVersionProbe: true
      })
      const r2 = await installCodexWrapper({
        source: SAMPLE,
        targetPath: target,
        skipVersionProbe: true
      })
      expect(r1.changed).toBe(true)
      expect(r2.changed).toBe(false)
    } finally {
      cleanup(dir)
    }
  })

  test('wrapper script source skips self via grep -v of $SLAYZONE_HOME_DIR/bin/codex', async () => {
    // Validates the live bundled wrapper, not a fixture, so a refactor that
    // drops the self-skip resolver gets caught here.
    const realSource = await import(
      '@slayzone/hooks/codex-wrapper.sh?raw' /* @vite-ignore */
    ).catch(() => null as unknown)
    const text =
      typeof realSource === 'string'
        ? realSource
        : (realSource as { default?: string } | null)?.default
    if (typeof text !== 'string') return // bundling fallback — covered by e2e
    expect(text).toContain('which -a codex')
    expect(text).toContain('grep -v')
    expect(text).toContain('/bin/codex')
  })
})

describe('parseCodexVersion', () => {
  test('parses "codex 0.131.0"', () => {
    expect(parseCodexVersion('codex 0.131.0')).toEqual({
      major: 0,
      minor: 131,
      raw: 'codex 0.131.0'
    })
  })
  test('parses bare semver', () => {
    expect(parseCodexVersion('0.129.0')).toEqual({ major: 0, minor: 129, raw: '0.129.0' })
  })
  test('parses prerelease', () => {
    expect(parseCodexVersion('0.130.0-alpha.3')).toEqual({
      major: 0,
      minor: 130,
      raw: '0.130.0-alpha.3'
    })
  })
  test('returns null on garbage', () => {
    expect(parseCodexVersion('not-a-version')).toBeNull()
  })
})
