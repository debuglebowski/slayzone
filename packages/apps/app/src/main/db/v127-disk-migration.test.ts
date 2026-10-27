/**
 * v127 disk-dir migration tests.
 */
import { describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrateV127DiskDir } from './v127-disk-migration.js'

function freshRoot(): { root: string; old: string; new_: string } {
  const root = mkdtempSync(join(tmpdir(), 'v127-test-'))
  return { root, old: join(root, 'assets'), new_: join(root, 'artifacts') }
}
function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

function seedFile(p: string, content: string): void {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content, 'utf-8')
}

describe('v127 disk-dir migration', () => {
  test('noop when neither dir exists', () => {
    const { root, old, new_ } = freshRoot()
    try {
      rmSync(root, { recursive: true, force: true })
      const r = migrateV127DiskDir(old, new_)
      expect(r.mode, 'mode').toBe('noop')
      expect(existsSync(old), 'old should not exist').toBe(false)
      expect(existsSync(new_), 'new should not exist').toBe(false)
    } finally {
      cleanup(root)
    }
  })

  test('noop when only new exists', () => {
    const { root, old, new_ } = freshRoot()
    try {
      seedFile(join(new_, 'taskA', 'file.md'), 'fresh')
      const r = migrateV127DiskDir(old, new_)
      expect(r.mode, 'mode').toBe('noop')
      expect(readFileSync(join(new_, 'taskA', 'file.md'), 'utf-8'), 'fresh untouched').toBe('fresh')
    } finally {
      cleanup(root)
    }
  })

  test('rename when only old exists', () => {
    const { root, old, new_ } = freshRoot()
    try {
      seedFile(join(old, 'taskA', 'a.md'), 'A')
      seedFile(join(old, 'taskB', 'b.md'), 'B')
      const r = migrateV127DiskDir(old, new_)
      expect(r.mode, 'mode').toBe('rename')
      expect(r.oldDirRemoved, 'old removed').toBe(true)
      expect(existsSync(old), 'old gone').toBe(false)
      expect(readFileSync(join(new_, 'taskA', 'a.md'), 'utf-8'), 'A migrated').toBe('A')
      expect(readFileSync(join(new_, 'taskB', 'b.md'), 'utf-8'), 'B migrated').toBe('B')
    } finally {
      cleanup(root)
    }
  })

  test('merge: disjoint task dirs — all moved, old removed', () => {
    const { root, old, new_ } = freshRoot()
    try {
      seedFile(join(old, 'taskOld', 'old.md'), 'OLD')
      seedFile(join(new_, 'taskNew', 'new.md'), 'NEW')
      const r = migrateV127DiskDir(old, new_)
      expect(r.mode, 'mode').toBe('merge')
      expect(r.taskDirsMoved, 'taskDirsMoved').toBe(1)
      expect(r.filesMoved, 'filesMoved').toBe(0)
      expect(r.conflicts, 'conflicts').toBe(0)
      expect(r.oldDirRemoved, 'old removed').toBe(true)
      expect(readFileSync(join(new_, 'taskOld', 'old.md'), 'utf-8'), 'old content moved').toBe(
        'OLD'
      )
      expect(readFileSync(join(new_, 'taskNew', 'new.md'), 'utf-8'), 'new content kept').toBe('NEW')
    } finally {
      cleanup(root)
    }
  })

  test('merge: same task, disjoint files — files merged into existing task dir', () => {
    const { root, old, new_ } = freshRoot()
    try {
      seedFile(join(old, 'taskShared', 'old-only.md'), 'OLD')
      seedFile(join(new_, 'taskShared', 'new-only.md'), 'NEW')
      const r = migrateV127DiskDir(old, new_)
      expect(r.mode, 'mode').toBe('merge')
      expect(r.taskDirsMoved, 'taskDirsMoved').toBe(0)
      expect(r.filesMoved, 'filesMoved').toBe(1)
      expect(r.conflicts, 'conflicts').toBe(0)
      expect(readFileSync(join(new_, 'taskShared', 'old-only.md'), 'utf-8'), 'old file moved').toBe(
        'OLD'
      )
      expect(readFileSync(join(new_, 'taskShared', 'new-only.md'), 'utf-8'), 'new file kept').toBe(
        'NEW'
      )
    } finally {
      cleanup(root)
    }
  })

  test('merge: file collision — old kept in place, conflict counted, content NOT overwritten', () => {
    const { root, old, new_ } = freshRoot()
    try {
      seedFile(join(old, 'taskShared', 'same.md'), 'OLD-VERSION')
      seedFile(join(new_, 'taskShared', 'same.md'), 'NEW-VERSION')
      const r = migrateV127DiskDir(old, new_)
      expect(r.mode, 'mode').toBe('merge')
      expect(r.conflicts, 'conflicts').toBe(1)
      expect(r.filesMoved, 'filesMoved').toBe(0)
      expect(r.oldDirRemoved, 'old kept (non-empty)').toBe(false)
      expect(
        readFileSync(join(new_, 'taskShared', 'same.md'), 'utf-8'),
        'new not overwritten'
      ).toBe('NEW-VERSION')
      expect(
        readFileSync(join(old, 'taskShared', 'same.md'), 'utf-8'),
        'old preserved for recovery'
      ).toBe('OLD-VERSION')
    } finally {
      cleanup(root)
    }
  })

  test('merge: empty old dir → removed cleanly', () => {
    const { root, old, new_ } = freshRoot()
    try {
      mkdirSync(old, { recursive: true })
      seedFile(join(new_, 'taskA', 'file.md'), 'NEW')
      const r = migrateV127DiskDir(old, new_)
      expect(r.mode, 'mode').toBe('merge')
      expect(r.oldDirRemoved, 'empty old removed').toBe(true)
      expect(existsSync(old), 'old gone').toBe(false)
    } finally {
      cleanup(root)
    }
  })

  test('idempotent: second call after successful rename is noop', () => {
    const { root, old, new_ } = freshRoot()
    try {
      seedFile(join(old, 'taskA', 'a.md'), 'A')
      migrateV127DiskDir(old, new_)
      const r2 = migrateV127DiskDir(old, new_)
      expect(r2.mode, 'second call noop').toBe('noop')
      expect(readFileSync(join(new_, 'taskA', 'a.md'), 'utf-8'), 'content intact').toBe('A')
    } finally {
      cleanup(root)
    }
  })
})
