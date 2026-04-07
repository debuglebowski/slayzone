/**
 * CLI assets mv/mvdir tests
 * Run with: ELECTRON_RUN_AS_NODE=1 electron --import tsx/esm packages/apps/cli/test/assets-mv.test.ts
 */
import Database from 'better-sqlite3'
import { test, expect, describe } from '../../../shared/test-utils/ipc-harness.js'
import { createSlayDbAdapter } from './test-harness.js'

// Create in-memory DB with just the tables we need (avoids dagre barrel import via migrations)
const rawDb = new Database(':memory:')
rawDb.pragma('foreign_keys = ON')
rawDb.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL, status TEXT DEFAULT 'inbox', priority INTEGER DEFAULT 3,
    terminal_mode TEXT DEFAULT 'claude-code', provider_config TEXT DEFAULT '{}',
    "order" INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE asset_folders (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES asset_folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL, "order" INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE task_assets (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    folder_id TEXT DEFAULT NULL REFERENCES asset_folders(id) ON DELETE SET NULL,
    title TEXT NOT NULL, render_mode TEXT DEFAULT NULL, language TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

const db = createSlayDbAdapter(rawDb)

const projectId = crypto.randomUUID()
rawDb.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'AssetMvProj', '#000')

function createTask(title: string) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  rawDb.prepare(
    `INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, "order", created_at, updated_at)
     VALUES (?, ?, ?, 'inbox', 3, 'claude-code', '{}', 0, ?, ?)`
  ).run(id, projectId, title, now, now)
  return id
}

function createFolder(taskId: string, name: string, parentId: string | null = null) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  rawDb.prepare(
    `INSERT INTO asset_folders (id, task_id, parent_id, name, "order", created_at)
     VALUES (?, ?, ?, ?, 0, ?)`
  ).run(id, taskId, parentId, name, now)
  return id
}

function createAsset(taskId: string, title: string, folderId: string | null = null) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  rawDb.prepare(
    `INSERT INTO task_assets (id, task_id, folder_id, title, "order", created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`
  ).run(id, taskId, folderId, title, now, now)
  return id
}

function getFolderParent(folderId: string): string | null {
  const row = rawDb.prepare('SELECT parent_id FROM asset_folders WHERE id = ?').get(folderId) as { parent_id: string | null }
  return row.parent_id
}

function getAssetFolder(assetId: string): string | null {
  const row = rawDb.prepare('SELECT folder_id FROM task_assets WHERE id = ?').get(assetId) as { folder_id: string | null }
  return row.folder_id
}

// --- mv (asset move) ---

await describe('assets mv — move asset to folder', () => {
  test('moves asset into a folder', () => {
    const taskId = createTask('MvAssetToFolder')
    const folderId = createFolder(taskId, 'TargetFolder')
    const assetId = createAsset(taskId, 'test.md')
    expect(getAssetFolder(assetId)).toBeNull()

    db.run(
      `UPDATE task_assets SET folder_id = :folderId, updated_at = :now WHERE id = :id`,
      { ':folderId': folderId, ':now': new Date().toISOString(), ':id': assetId }
    )
    expect(getAssetFolder(assetId)).toBe(folderId)
  })

  test('moves asset to root', () => {
    const taskId = createTask('MvAssetToRoot')
    const folderId = createFolder(taskId, 'SrcFolder')
    const assetId = createAsset(taskId, 'test.md', folderId)
    expect(getAssetFolder(assetId)).toBe(folderId)

    db.run(
      `UPDATE task_assets SET folder_id = :folderId, updated_at = :now WHERE id = :id`,
      { ':folderId': null, ':now': new Date().toISOString(), ':id': assetId }
    )
    expect(getAssetFolder(assetId)).toBeNull()
  })
})

// --- mvdir (folder move) ---

await describe('assets mvdir — move folder to parent', () => {
  test('moves folder into another folder', () => {
    const taskId = createTask('MvdirInto')
    const parentId = createFolder(taskId, 'Parent')
    const childId = createFolder(taskId, 'Child')
    expect(getFolderParent(childId)).toBeNull()

    db.run(
      `UPDATE asset_folders SET parent_id = :parentId WHERE id = :id`,
      { ':parentId': parentId, ':id': childId }
    )
    expect(getFolderParent(childId)).toBe(parentId)
  })

  test('moves folder to root', () => {
    const taskId = createTask('MvdirToRoot')
    const parentId = createFolder(taskId, 'Parent')
    const childId = createFolder(taskId, 'Child', parentId)
    expect(getFolderParent(childId)).toBe(parentId)

    db.run(
      `UPDATE asset_folders SET parent_id = :parentId WHERE id = :id`,
      { ':parentId': null, ':id': childId }
    )
    expect(getFolderParent(childId)).toBeNull()
  })
})

await describe('assets mvdir — cycle detection', () => {
  test('detects direct cycle (move into own child)', () => {
    const taskId = createTask('CycleDirect')
    const parentId = createFolder(taskId, 'Parent')
    const childId = createFolder(taskId, 'Child', parentId)

    // Attempting to move Parent into Child should detect cycle
    let detected = false
    let cur: string | null = childId
    while (cur) {
      if (cur === parentId) { detected = true; break }
      const row = db.query<{ parent_id: string | null }>(
        `SELECT parent_id FROM asset_folders WHERE id = :id`,
        { ':id': cur }
      )[0]
      cur = row?.parent_id ?? null
    }
    expect(detected).toBe(true)
  })

  test('detects deep cycle (move into grandchild)', () => {
    const taskId = createTask('CycleDeep')
    const a = createFolder(taskId, 'A')
    const b = createFolder(taskId, 'B', a)
    const c = createFolder(taskId, 'C', b)

    // Moving A into C should detect cycle: C->B->A (found!)
    let detected = false
    let cur: string | null = c
    while (cur) {
      if (cur === a) { detected = true; break }
      const row = db.query<{ parent_id: string | null }>(
        `SELECT parent_id FROM asset_folders WHERE id = :id`,
        { ':id': cur }
      )[0]
      cur = row?.parent_id ?? null
    }
    expect(detected).toBe(true)
  })

  test('no false positive for unrelated folders', () => {
    const taskId = createTask('NoCycle')
    const a = createFolder(taskId, 'A')
    const b = createFolder(taskId, 'B')

    // Moving A into B should NOT detect cycle
    let detected = false
    let cur: string | null = b
    while (cur) {
      if (cur === a) { detected = true; break }
      const row = db.query<{ parent_id: string | null }>(
        `SELECT parent_id FROM asset_folders WHERE id = :id`,
        { ':id': cur }
      )[0]
      cur = row?.parent_id ?? null
    }
    expect(detected).toBe(false)
  })

  test('self-move detected as cycle', () => {
    const taskId = createTask('SelfMove')
    const a = createFolder(taskId, 'A')

    // Moving A into A: target=A, source=A → cur=A === source → cycle
    let detected = false
    let cur: string | null = a
    while (cur) {
      if (cur === a) { detected = true; break }
      const row = db.query<{ parent_id: string | null }>(
        `SELECT parent_id FROM asset_folders WHERE id = :id`,
        { ':id': cur }
      )[0]
      cur = row?.parent_id ?? null
    }
    expect(detected).toBe(true)
  })
})

await describe('assets mvdir — preserves children', () => {
  test('child assets stay in moved folder', () => {
    const taskId = createTask('MvdirKeepsAssets')
    const folderA = createFolder(taskId, 'A')
    const folderB = createFolder(taskId, 'B')
    const assetId = createAsset(taskId, 'note.md', folderA)

    // Move folderA into folderB
    db.run(
      `UPDATE asset_folders SET parent_id = :parentId WHERE id = :id`,
      { ':parentId': folderB, ':id': folderA }
    )

    // Asset still belongs to folderA
    expect(getAssetFolder(assetId)).toBe(folderA)
    // FolderA is now inside folderB
    expect(getFolderParent(folderA)).toBe(folderB)
  })

  test('nested subfolders move with parent', () => {
    const taskId = createTask('MvdirKeepsSubfolders')
    const root = createFolder(taskId, 'Root')
    const sub = createFolder(taskId, 'Sub', root)
    const target = createFolder(taskId, 'Target')

    // Move root into target
    db.run(
      `UPDATE asset_folders SET parent_id = :parentId WHERE id = :id`,
      { ':parentId': target, ':id': root }
    )

    // Sub still has root as parent (unchanged)
    expect(getFolderParent(sub)).toBe(root)
    // Root is now inside target
    expect(getFolderParent(root)).toBe(target)
  })
})

rawDb.close()
console.log('\nDone')
