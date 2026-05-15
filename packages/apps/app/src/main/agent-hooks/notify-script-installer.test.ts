import fs from 'fs'
import path from 'path'
import os from 'os'
import { describe, test, expect } from 'vitest'
import { installNotifyScript } from './notify-script-installer'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-notify-installer-'))
}

function cleanup(...dirs: string[]) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
}

const SAMPLE = '#!/bin/sh\necho hi\n'

describe('installNotifyScript', () => {
  test('writes script to ~/.slayzone/hooks/notify.sh by default', async () => {
    const dir = tmpDir()
    const target = path.join(dir, '.slayzone', 'hooks', 'notify.sh')
    try {
      const result = await installNotifyScript({ source: SAMPLE, targetPath: target })
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
    const target = path.join(dir, 'notify.sh')
    try {
      await installNotifyScript({ source: SAMPLE, targetPath: target })
      const stat = fs.statSync(target)
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).toBe(0o755)
    } finally {
      cleanup(dir)
    }
  })

  test('idempotent — no-op on rerun w/ same content', async () => {
    const dir = tmpDir()
    const target = path.join(dir, 'notify.sh')
    try {
      const r1 = await installNotifyScript({ source: SAMPLE, targetPath: target })
      const r2 = await installNotifyScript({ source: SAMPLE, targetPath: target })
      expect(r1.changed).toBe(true)
      expect(r2.changed).toBe(false)
    } finally {
      cleanup(dir)
    }
  })
})
