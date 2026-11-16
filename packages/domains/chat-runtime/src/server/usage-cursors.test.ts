/**
 * The computer's usage-log read offsets live in its per-hub chat store (v10; hub
 * v209): the hub's handoff never overwrites one kept here, a commit moves it, and
 * they survive a reopen.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { openChatStorage } from './storage'
import { usageCursorStore } from './usage-cursors'

test('seed keeps local cursors, commit moves them, both persist', () => {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'usage-cursors-')))
  try {
    let storage = openChatStorage({ stateDir, hubScope: 'hub' })
    let cursors = usageCursorStore(storage)
    cursors.commit([{ sourceFile: '/a', offset: 10, modifiedMs: 1.5 }])
    cursors.seed({ '/a': { offset: 1, modifiedMs: 1 }, '/b': { offset: 7, modifiedMs: 2 } })
    expect(cursors.all()).toEqual({
      '/a': { offset: 10, modifiedMs: 1.5 },
      '/b': { offset: 7, modifiedMs: 2 }
    })
    cursors.commit([{ sourceFile: '/b', offset: 20, modifiedMs: 3 }])
    storage.close()
    storage = openChatStorage({ stateDir, hubScope: 'hub' })
    cursors = usageCursorStore(storage)
    expect(cursors.all()).toEqual({
      '/a': { offset: 10, modifiedMs: 1.5 },
      '/b': { offset: 20, modifiedMs: 3 }
    })
    // Another hub's store is separate.
    const other = openChatStorage({ stateDir, hubScope: 'other-hub' })
    expect(usageCursorStore(other).all()).toEqual({})
    other.close()
    storage.close()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
