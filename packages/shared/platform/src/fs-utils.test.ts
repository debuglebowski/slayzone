import fs from 'fs'
import path from 'path'
import os from 'os'
import { describe, test, expect } from 'vitest'
import { writeFileIfChanged } from './fs-utils'

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
