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
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {}
  }
}

const SAMPLE = '#!/bin/sh\necho hi\n'

/** Versioned script sample: carries the `SLAYZONE_NOTIFY_VERSION` marker. */
const V = (n: number): string => `#!/bin/sh\n# SLAYZONE_NOTIFY_VERSION=${n}\necho hi v${n}\n`

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

  // Version gate: two SlayZone channels (prod + dev) share one on-disk
  // notify.sh. The newer script is backward-compatible (an older server ignores
  // extra fields), but an OLDER app must never downgrade a NEWER script — that
  // is the clobber that made warm-pool sessions invisible (no slaySessionId →
  // no task resolution → no spinner / no unread). Highest version wins,
  // regardless of channel or boot order.
  describe('version gate', () => {
    test('upgrades: newer version overwrites older on-disk script', async () => {
      const dir = tmpDir()
      const target = path.join(dir, 'notify.sh')
      try {
        await installNotifyScript({ source: V(1), targetPath: target })
        const result = await installNotifyScript({ source: V(2), targetPath: target })
        expect(result.changed).toBe(true)
        expect(fs.readFileSync(target, 'utf8')).toBe(V(2))
      } finally {
        cleanup(dir)
      }
    })

    test('refuses downgrade: older version does NOT overwrite newer on-disk script', async () => {
      const dir = tmpDir()
      const target = path.join(dir, 'notify.sh')
      try {
        await installNotifyScript({ source: V(2), targetPath: target })
        const result = await installNotifyScript({ source: V(1), targetPath: target })
        expect(result.changed).toBe(false)
        // On-disk NEWER script is preserved byte-for-byte.
        expect(fs.readFileSync(target, 'utf8')).toBe(V(2))
      } finally {
        cleanup(dir)
      }
    })

    test('equal version → no-op (idempotent)', async () => {
      const dir = tmpDir()
      const target = path.join(dir, 'notify.sh')
      try {
        await installNotifyScript({ source: V(2), targetPath: target })
        const result = await installNotifyScript({ source: V(2), targetPath: target })
        expect(result.changed).toBe(false)
      } finally {
        cleanup(dir)
      }
    })

    test('unversioned on-disk script is treated as v0 → any versioned script upgrades it', async () => {
      const dir = tmpDir()
      const target = path.join(dir, 'notify.sh')
      try {
        // Legacy stale script with no version marker (the real clobber victim).
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, SAMPLE)
        const result = await installNotifyScript({ source: V(1), targetPath: target })
        expect(result.changed).toBe(true)
        expect(fs.readFileSync(target, 'utf8')).toBe(V(1))
      } finally {
        cleanup(dir)
      }
    })

    test('missing on-disk script → writes regardless of version', async () => {
      const dir = tmpDir()
      const target = path.join(dir, '.slayzone', 'hooks', 'notify.sh')
      try {
        const result = await installNotifyScript({ source: V(5), targetPath: target })
        expect(result.changed).toBe(true)
        expect(fs.readFileSync(target, 'utf8')).toBe(V(5))
      } finally {
        cleanup(dir)
      }
    })
  })
})
