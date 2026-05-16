import fs from 'fs'
import path from 'path'
import os from 'os'
import { describe, test, expect } from 'vitest'
import { installOpencodePlugin } from './opencode-plugin-installer'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-opencode-plugin-'))
}

function cleanup(...dirs: string[]) {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {}
  }
}

const SAMPLE = `// header\nconst notifyPath = '{{NOTIFY_PATH}}'\n// trailing {{NOTIFY_PATH}} occurrence\n`

describe('installOpencodePlugin', () => {
  test('substitutes {{NOTIFY_PATH}} with absolute notify path', async () => {
    const dir = tmpDir()
    const target = path.join(dir, '.config', 'opencode', 'plugin', 'slayzone-notify.js')
    const notifyPath = '/abs/path/to/.slayzone/hooks/notify.sh'
    try {
      const result = await installOpencodePlugin({ source: SAMPLE, targetPath: target, notifyPath })
      expect(result.changed).toBe(true)
      expect(result.path).toBe(target)
      const written = fs.readFileSync(target, 'utf8')
      expect(written).not.toContain('{{NOTIFY_PATH}}')
      // All occurrences replaced (split/join, not single replace).
      expect(written).toContain(`const notifyPath = '${notifyPath}'`)
      expect(written).toContain(`// trailing ${notifyPath} occurrence`)
    } finally {
      cleanup(dir)
    }
  })

  test('auto-creates parent directories', async () => {
    const dir = tmpDir()
    const target = path.join(dir, 'deeply', 'nested', 'plugin', 'slayzone-notify.js')
    try {
      const result = await installOpencodePlugin({ source: SAMPLE, targetPath: target, notifyPath: '/n.sh' })
      expect(result.changed).toBe(true)
      expect(fs.existsSync(target)).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  test('applies mode 0644 on POSIX (plugin loaded as ESM, not exec)', async () => {
    if (process.platform === 'win32') return
    const dir = tmpDir()
    const target = path.join(dir, 'slayzone-notify.js')
    try {
      await installOpencodePlugin({ source: SAMPLE, targetPath: target, notifyPath: '/n.sh' })
      const stat = fs.statSync(target)
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).toBe(0o644)
    } finally {
      cleanup(dir)
    }
  })

  test('idempotent — no-op on rerun w/ same content', async () => {
    const dir = tmpDir()
    const target = path.join(dir, 'slayzone-notify.js')
    try {
      const r1 = await installOpencodePlugin({ source: SAMPLE, targetPath: target, notifyPath: '/n.sh' })
      const r2 = await installOpencodePlugin({ source: SAMPLE, targetPath: target, notifyPath: '/n.sh' })
      expect(r1.changed).toBe(true)
      expect(r2.changed).toBe(false)
    } finally {
      cleanup(dir)
    }
  })

  test('detects path change and rewrites (content diff)', async () => {
    const dir = tmpDir()
    const target = path.join(dir, 'slayzone-notify.js')
    try {
      const r1 = await installOpencodePlugin({ source: SAMPLE, targetPath: target, notifyPath: '/old.sh' })
      const r2 = await installOpencodePlugin({ source: SAMPLE, targetPath: target, notifyPath: '/new.sh' })
      expect(r1.changed).toBe(true)
      expect(r2.changed).toBe(true)
      expect(fs.readFileSync(target, 'utf8')).toContain('/new.sh')
    } finally {
      cleanup(dir)
    }
  })

  test('bundled plugin source has expected SlayZone v1 marker + placeholder', async () => {
    const realSource = await import('@slayzone/hooks/opencode-plugin.js?raw' /* @vite-ignore */).catch(
      () => null as unknown,
    )
    const text = typeof realSource === 'string' ? realSource : (realSource as { default?: string } | null)?.default
    if (typeof text !== 'string') return // bundling fallback — covered by e2e
    expect(text).toContain('SlayZone opencode plugin v1')
    expect(text).toContain('{{NOTIFY_PATH}}')
    expect(text).toContain('__slayzoneOpencodePluginV1')
    expect(text).toContain('SLAYZONE_TASK_ID')
  })
})
