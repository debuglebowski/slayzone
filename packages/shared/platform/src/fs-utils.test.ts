import fs from 'fs'
import path from 'path'
import os from 'os'
import { describe, test, expect } from 'vitest'
import { updateFileAtomically, writeFileIfChanged } from './fs-utils'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-fs-utils-test-'))
}

function cleanup(...dirs: string[]) {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {}
  }
}

describe('writeFileIfChanged', () => {
  test('creates file when missing', async () => {
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'nested', 'a.txt')
      const changed = await writeFileIfChanged(target, 'hello')
      expect(changed).toBe(true)
      expect(fs.readFileSync(target, 'utf8')).toBe('hello')
    } finally {
      cleanup(dir)
    }
  })

  test('no-op on identical content', async () => {
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'a.txt')
      fs.writeFileSync(target, 'same')
      const changed = await writeFileIfChanged(target, 'same')
      expect(changed).toBe(false)
    } finally {
      cleanup(dir)
    }
  })

  test('writes when content differs', async () => {
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'a.txt')
      fs.writeFileSync(target, 'old')
      const changed = await writeFileIfChanged(target, 'new')
      expect(changed).toBe(true)
      expect(fs.readFileSync(target, 'utf8')).toBe('new')
    } finally {
      cleanup(dir)
    }
  })

  test('applies mode on POSIX', async () => {
    if (process.platform === 'win32') return // chmod is a no-op on Windows
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'script.sh')
      await writeFileIfChanged(target, '#!/bin/sh\necho hi\n', 0o755)
      const stat = fs.statSync(target)

      expect(stat.mode & 0o777).toBe(0o755)
    } finally {
      cleanup(dir)
    }
  })

  test('writes through symlink to real target', async () => {
    if (process.platform === 'win32') return
    const dir = tmpDir()
    try {
      const real = path.join(dir, 'real.txt')
      const link = path.join(dir, 'link.txt')
      fs.writeFileSync(real, 'before')
      fs.symlinkSync(real, link)
      const changed = await writeFileIfChanged(link, 'after')
      expect(changed).toBe(true)
      expect(fs.readFileSync(real, 'utf8')).toBe('after')
      // Link still a symlink.
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  test('accepts Buffer content', async () => {
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'bin.dat')
      const buf = Buffer.from([0x00, 0x01, 0x02])
      const changed = await writeFileIfChanged(target, buf)
      expect(changed).toBe(true)
      expect(fs.readFileSync(target).equals(buf)).toBe(true)
    } finally {
      cleanup(dir)
    }
  })
})

/**
 * Release once `n` participants have arrived — or after `timeoutMs`, whichever
 * comes first.
 *
 * The timeout is load-bearing, not defensive. Held inside the merge callback, this
 * forces both writers to read the SAME baseline whenever the implementation lets
 * their merges overlap — the exact interleaving that loses an update, and without
 * it these tests would pass by luck on a fast machine. But a correct
 * implementation may instead SERIALIZE the cycle, in which case the second writer
 * can never arrive while the first is holding, and a strict barrier would
 * deadlock. Timing out keeps the test an assertion about the OUTCOME (no update is
 * lost) rather than about the mechanism used to achieve it, so it stays valid
 * whether the fix is a lock, a retry, or something else later.
 */
function barrier(n: number, timeoutMs = 60): () => Promise<void> {
  let arrived = 0
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  return async () => {
    if (++arrived >= n) release()
    await Promise.race([gate, new Promise<void>((r) => setTimeout(r, timeoutMs))])
  }
}

/**
 * `updateFileAtomically` owns the whole read → merge → write cycle so it can
 * detect that the file moved under it and re-run the merge against the new state.
 *
 * `writeFileIfChanged` cannot do this by construction: it only ever sees the
 * FINAL bytes, so by the time it is called the caller's merge has already been
 * computed against a baseline that may be stale. That was harmless while exactly
 * one process type (the desktop app) installed hooks — identical inputs converge
 * on identical bytes — and stops being harmless the moment a standalone runner
 * becomes a second installer on the same machine.
 */
describe('updateFileAtomically', () => {
  test('concurrent merges do not lose an update', async () => {
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'settings.json')
      fs.writeFileSync(target, JSON.stringify({}))
      const arrive = barrier(2)

      const addKey = (key: string): Promise<boolean> =>
        updateFileAtomically(target, async (current) => {
          const obj = JSON.parse(current ? current.toString('utf8') : '{}') as Record<
            string,
            boolean
          >
          // Both writers are now holding the SAME baseline. On a retry the gate is
          // already open, so the re-run reads fresh state and proceeds immediately.
          await arrive()
          obj[key] = true
          return JSON.stringify(obj)
        })

      await Promise.all([addKey('a'), addKey('b')])

      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ a: true, b: true })
    } finally {
      cleanup(dir)
    }
  })

  test('a stale writer never downgrades a fresher one, in either completion order', async () => {
    const dir = tmpDir()
    try {
      // The notify.sh shape: a version-gated installer that must only ever move the
      // file UPWARD. This is the documented incident — a stale writer clobbered a
      // fresher script and stripped slaySessionId, breaking warm-pool tracking.
      const target = path.join(dir, 'notify.sh')
      fs.writeFileSync(target, 'VERSION=1\n')
      const arrive = barrier(2)
      const versionOf = (b: Buffer | null): number =>
        b ? Number(/VERSION=(\d+)/.exec(b.toString('utf8'))?.[1] ?? 0) : 0

      const install = (version: number): Promise<boolean> =>
        updateFileAtomically(target, async (current) => {
          const onDisk = versionOf(current)
          await arrive()
          // The gate itself is evaluated against `current` — so it only holds if
          // `current` is guaranteed to be what we are about to overwrite.
          if (onDisk >= version) return null
          return `VERSION=${version}\n`
        })

      await Promise.all([install(5), install(3)])

      expect(fs.readFileSync(target, 'utf8')).toBe('VERSION=5\n')
    } finally {
      cleanup(dir)
    }
  })

  test('merge returning null is a no-op, not an empty file', async () => {
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'a.txt')
      fs.writeFileSync(target, 'keep me')
      const changed = await updateFileAtomically(target, () => null)
      expect(changed).toBe(false)
      expect(fs.readFileSync(target, 'utf8')).toBe('keep me')
    } finally {
      cleanup(dir)
    }
  })

  test('identical merged content is a no-op', async () => {
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'a.txt')
      fs.writeFileSync(target, 'same')
      const changed = await updateFileAtomically(target, () => 'same')
      expect(changed).toBe(false)
    } finally {
      cleanup(dir)
    }
  })

  test('creates a missing file, passing null to the merge', async () => {
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'nested', 'new.txt')
      let sawNull = false
      const changed = await updateFileAtomically(target, (current) => {
        sawNull = current === null
        return 'created'
      })
      expect(changed).toBe(true)
      expect(sawNull).toBe(true)
      expect(fs.readFileSync(target, 'utf8')).toBe('created')
    } finally {
      cleanup(dir)
    }
  })

  test('applies mode on POSIX', async () => {
    if (process.platform === 'win32') return
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'hook.sh')
      await updateFileAtomically(target, () => '#!/bin/sh\n', { mode: 0o755 })
      expect(fs.statSync(target).mode & 0o777).toBe(0o755)
    } finally {
      cleanup(dir)
    }
  })

  test('leaves no .tmp litter behind after a contended write', async () => {
    const dir = tmpDir()
    try {
      const target = path.join(dir, 'settings.json')
      fs.writeFileSync(target, '{}')
      const arrive = barrier(2)
      const addKey = (key: string): Promise<boolean> =>
        updateFileAtomically(target, async (current) => {
          const obj = JSON.parse(current ? current.toString('utf8') : '{}') as Record<
            string,
            boolean
          >
          await arrive()
          obj[key] = true
          return JSON.stringify(obj)
        })

      await Promise.all([addKey('a'), addKey('b')])

      // A retry that abandons its temp file would slowly fill the user's ~/.claude.
      expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([])
    } finally {
      cleanup(dir)
    }
  })
})
