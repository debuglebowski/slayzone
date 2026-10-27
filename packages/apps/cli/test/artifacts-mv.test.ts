/**
 * CLI artifacts mv/mvdir tests
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/cli/test/artifacts-mv.test.ts
 */
import Database from 'better-sqlite3'
import { afterAll, describe, expect, test } from 'vitest'
import { createSlayDbAdapter } from './test-harness.js'

// Create in-memory DB with just the tables we need (avoids dagre barrel import via migrations)
const rawDb = new Database(':memory:')
rawDb.pragma('foreign_keys = ON')
afterAll(() => rawDb.close())
rawDb.exec(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL, status TEXT DEFAULT 'inbox', priority INTEGER DEFAULT 3,
    terminal_mode TEXT DEFAULT 'claude-code', provider_config TEXT DEFAULT '{}',
    "order" INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE artifact_folders (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES artifact_folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL, "order" INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE task_artifacts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    folder_id TEXT DEFAULT NULL REFERENCES artifact_folders(id) ON DELETE SET NULL,
    title TEXT NOT NULL, render_mode TEXT DEFAULT NULL, language TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

const db = createSlayDbAdapter(rawDb)

const projectId = crypto.randomUUID()
rawDb
  .prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)')
  .run(projectId, 'ArtifactMvProj', '#000')

function createTask(title: string) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  rawDb
    .prepare(
      `INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config, "order", created_at, updated_at)
     VALUES (?, ?, ?, 'inbox', 3, 'claude-code', '{}', 0, ?, ?)`
    )
    .run(id, projectId, title, now, now)
  return id
}

function createFolder(taskId: string, name: string, parentId: string | null = null) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  rawDb
    .prepare(
      `INSERT INTO artifact_folders (id, task_id, parent_id, name, "order", created_at)
     VALUES (?, ?, ?, ?, 0, ?)`
    )
    .run(id, taskId, parentId, name, now)
  return id
}

function createArtifact(taskId: string, title: string, folderId: string | null = null) {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  rawDb
    .prepare(
      `INSERT INTO task_artifacts (id, task_id, folder_id, title, "order", created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    .run(id, taskId, folderId, title, now, now)
  return id
}

function getFolderParent(folderId: string): string | null {
  const row = rawDb
    .prepare('SELECT parent_id FROM artifact_folders WHERE id = ?')
    .get(folderId) as { parent_id: string | null }
  return row.parent_id
}

function getArtifactFolder(artifactId: string): string | null {
  const row = rawDb
    .prepare('SELECT folder_id FROM task_artifacts WHERE id = ?')
    .get(artifactId) as { folder_id: string | null }
  return row.folder_id
}

// --- mv (artifact move) ---

describe('artifacts mv — move artifact to folder', () => {
  test('moves artifact into a folder', () => {
    const taskId = createTask('MvArtifactToFolder')
    const folderId = createFolder(taskId, 'TargetFolder')
    const artifactId = createArtifact(taskId, 'test.md')
    expect(getArtifactFolder(artifactId)).toBeNull()

    db.run(`UPDATE task_artifacts SET folder_id = :folderId, updated_at = :now WHERE id = :id`, {
      ':folderId': folderId,
      ':now': new Date().toISOString(),
      ':id': artifactId
    })
    expect(getArtifactFolder(artifactId)).toBe(folderId)
  })

  test('moves artifact to root', () => {
    const taskId = createTask('MvArtifactToRoot')
    const folderId = createFolder(taskId, 'SrcFolder')
    const artifactId = createArtifact(taskId, 'test.md', folderId)
    expect(getArtifactFolder(artifactId)).toBe(folderId)

    db.run(`UPDATE task_artifacts SET folder_id = :folderId, updated_at = :now WHERE id = :id`, {
      ':folderId': null,
      ':now': new Date().toISOString(),
      ':id': artifactId
    })
    expect(getArtifactFolder(artifactId)).toBeNull()
  })
})

// --- mvdir (folder move) ---

describe('artifacts mvdir — move folder to parent', () => {
  test('moves folder into another folder', () => {
    const taskId = createTask('MvdirInto')
    const parentId = createFolder(taskId, 'Parent')
    const childId = createFolder(taskId, 'Child')
    expect(getFolderParent(childId)).toBeNull()

    db.run(`UPDATE artifact_folders SET parent_id = :parentId WHERE id = :id`, {
      ':parentId': parentId,
      ':id': childId
    })
    expect(getFolderParent(childId)).toBe(parentId)
  })

  test('moves folder to root', () => {
    const taskId = createTask('MvdirToRoot')
    const parentId = createFolder(taskId, 'Parent')
    const childId = createFolder(taskId, 'Child', parentId)
    expect(getFolderParent(childId)).toBe(parentId)

    db.run(`UPDATE artifact_folders SET parent_id = :parentId WHERE id = :id`, {
      ':parentId': null,
      ':id': childId
    })
    expect(getFolderParent(childId)).toBeNull()
  })
})

describe('artifacts mvdir — cycle detection', () => {
  test('detects direct cycle (move into own child)', () => {
    const taskId = createTask('CycleDirect')
    const parentId = createFolder(taskId, 'Parent')
    const childId = createFolder(taskId, 'Child', parentId)

    // Attempting to move Parent into Child should detect cycle
    let detected = false
    let cur: string | null = childId
    while (cur) {
      if (cur === parentId) {
        detected = true
        break
      }
      const row = db.query<{ parent_id: string | null }>(
        `SELECT parent_id FROM artifact_folders WHERE id = :id`,
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
      if (cur === a) {
        detected = true
        break
      }
      const row = db.query<{ parent_id: string | null }>(
        `SELECT parent_id FROM artifact_folders WHERE id = :id`,
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
      if (cur === a) {
        detected = true
        break
      }
      const row = db.query<{ parent_id: string | null }>(
        `SELECT parent_id FROM artifact_folders WHERE id = :id`,
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
      if (cur === a) {
        detected = true
        break
      }
      const row = db.query<{ parent_id: string | null }>(
        `SELECT parent_id FROM artifact_folders WHERE id = :id`,
        { ':id': cur }
      )[0]
      cur = row?.parent_id ?? null
    }
    expect(detected).toBe(true)
  })
})

describe('artifacts mvdir — preserves children', () => {
  test('child artifacts stay in moved folder', () => {
    const taskId = createTask('MvdirKeepsArtifacts')
    const folderA = createFolder(taskId, 'A')
    const folderB = createFolder(taskId, 'B')
    const artifactId = createArtifact(taskId, 'note.md', folderA)

    // Move folderA into folderB
    db.run(`UPDATE artifact_folders SET parent_id = :parentId WHERE id = :id`, {
      ':parentId': folderB,
      ':id': folderA
    })

    // Artifact still belongs to folderA
    expect(getArtifactFolder(artifactId)).toBe(folderA)
    // FolderA is now inside folderB
    expect(getFolderParent(folderA)).toBe(folderB)
  })

  test('nested subfolders move with parent', () => {
    const taskId = createTask('MvdirKeepsSubfolders')
    const root = createFolder(taskId, 'Root')
    const sub = createFolder(taskId, 'Sub', root)
    const target = createFolder(taskId, 'Target')

    // Move root into target
    db.run(`UPDATE artifact_folders SET parent_id = :parentId WHERE id = :id`, {
      ':parentId': target,
      ':id': root
    })

    // Sub still has root as parent (unchanged)
    expect(getFolderParent(sub)).toBe(root)
    // Root is now inside target
    expect(getFolderParent(root)).toBe(target)
  })
})
