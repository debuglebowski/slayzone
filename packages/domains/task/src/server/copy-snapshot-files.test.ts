import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { copySnapshotRoot } from './copy-snapshot-files'

test.each(['../blobs', '..', '.', '/tmp/other', 'a/b', 'a\\b', 'C:blobs'])(
  'snapshot rejects unsafe move ID %s',
  (id) => {
    expect(() => copySnapshotRoot('/tmp/example-hub', id)).toThrow()
  }
)

test('snapshot accepts source and import journal IDs', () => {
  const root = join(tmpdir(), 'example-hub')
  expect(copySnapshotRoot(root, 'transfer-copy')).toBe(
    join(root, '.task-copy-snapshots', 'transfer-copy')
  )
})
