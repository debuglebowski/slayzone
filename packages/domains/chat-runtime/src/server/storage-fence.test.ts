import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { commitStorageFence } from './storage-fence'

test('a fence makes a real, fresh maintenance write; NORMAL is restored only on success', () => {
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE maintenance_cursors(id TEXT PRIMARY KEY, value TEXT)')
    db.pragma('synchronous=NORMAL')
    const first = commitStorageFence(db, { resumeNormal: true })
    const second = commitStorageFence(db, { resumeNormal: true })
    expect(first).not.toBe(second)
    expect(db.prepare('SELECT value FROM maintenance_cursors').get()).toEqual({
      value: JSON.stringify(second)
    })
    expect(db.pragma('synchronous', { simple: true })).toBe(1)
    commitStorageFence(db)
    expect(db.pragma('synchronous', { simple: true })).toBe(2)
  } finally {
    db.close()
  }
})

test('a failed fence never restores NORMAL or claims success', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('synchronous=NORMAL')
    expect(() => commitStorageFence(db, { resumeNormal: true })).toThrow(/maintenance_cursors/)
    expect(db.pragma('synchronous', { simple: true })).toBe(2)
  } finally {
    db.close()
  }
})

test('a fence refuses to split or escape an existing transaction', () => {
  const db = new Database(':memory:')
  try {
    db.exec('CREATE TABLE maintenance_cursors(id TEXT PRIMARY KEY, value TEXT)')
    db.pragma('synchronous=NORMAL')
    db.transaction(() => {
      expect(() => commitStorageFence(db)).toThrow(/outside.*transaction/i)
      expect(db.inTransaction).toBe(true)
    })()
    expect(db.pragma('synchronous', { simple: true })).toBe(1)
    expect(db.prepare('SELECT count(*) n FROM maintenance_cursors').get()).toEqual({ n: 0 })
  } finally {
    db.close()
  }
})

// Standalone child: instrumenting Vitest's own SQLite VFS crashed the review fork.
// POSIX native fixture; portable worker lifecycle/error tests also run on Windows.
test.skipIf(process.platform === 'win32')(
  'native owner cycles/fences: no main sync; delayed or failed xSync cannot acknowledge early',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'slz-fence-native-'))
    const here = fileURLToPath(new URL('.', import.meta.url))
    const extension = join(root, process.platform === 'darwin' ? 'syncprobe.dylib' : 'syncprobe.so')
    try {
      execFileSync(
        'cc',
        [
          '-std=c11',
          ...(process.platform === 'darwin' ? ['-dynamiclib'] : ['-shared', '-fPIC']),
          '-O2',
          '-pthread',
          '-I',
          fileURLToPath(
            new URL('../../../../../node_modules/better-sqlite3/deps/sqlite3', import.meta.url)
          ),
          join(here, 'storage-fence.syncprobe.c'),
          '-o',
          extension
        ],
        { stdio: 'pipe' }
      )
      const output = execFileSync(
        process.execPath,
        [join(here, 'storage-fence.native.fixture.cjs'), root, extension],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          encoding: 'utf8',
          timeout: 30_000
        }
      )
      const result = JSON.parse(output)
      expect(result).toMatchObject({
        mainSyncs: 0,
        normalCommitSyncs: 0,
        fenceSyncs: 1,
        cycles: 30,
        failedCode: 'SQLITE_IOERR_FSYNC',
        heartbeatDuringSync: true,
        earlyAck: false,
        integrity: 'ok'
      })
      expect(result.workerSyncs).toBeGreaterThan(30)
      console.log('native storage fence:', output.trim())
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
