/**
 * Projects handler contract tests
 * Run with: npx tsx packages/domains/projects/src/main/handlers.test.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerProjectHandlers } from './handlers.js'
import type { ColumnConfig } from '../shared/types.js'

const h = await createTestHarness()
registerProjectHandlers(h.ipcMain as never, h.db)

function writeFeatureYaml(repoPath: string, relDir: string, content: string): void {
  const dir = path.join(repoPath, relDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'feature.yaml'), content, 'utf8')
}

describe('db:projects:create', () => {
  test('creates with defaults', () => {
    const p = h.invoke('db:projects:create', { name: 'Alpha', color: '#ff0000' }) as {
      id: string
      name: string
      color: string
      path: null
      task_backend: string
      feature_repo_integration_enabled: number
      feature_repo_features_path: string
    }
    expect(p.name).toBe('Alpha')
    expect(p.color).toBe('#ff0000')
    expect(p.path).toBeNull()
    expect(p.task_backend).toBe('db')
    expect(p.feature_repo_integration_enabled).toBe(0)
    expect(p.feature_repo_features_path).toBe('docs/features')
    expect(p.id).toBeTruthy()
  })

  test('creates with path', () => {
    const p = h.invoke('db:projects:create', { name: 'Beta', color: '#0000ff', path: '/tmp/beta' }) as { path: string }
    expect(p.path).toBe('/tmp/beta')
  })

  test('creates with custom columns config', () => {
    const columns: ColumnConfig[] = [
      { id: 'queue', label: 'Queue', color: 'gray', position: 2, category: 'unstarted' },
      { id: 'doing', label: 'Doing', color: 'blue', position: 3, category: 'started' },
      { id: 'closed', label: 'Closed', color: 'green', position: 9, category: 'completed' },
    ]
    const p = h.invoke('db:projects:create', {
      name: 'Columns Project',
      color: '#aabbcc',
      columnsConfig: columns
    }) as { columns_config: ColumnConfig[] | null }
    expect(p.columns_config).toEqual([
      { id: 'queue', label: 'Queue', color: 'gray', position: 0, category: 'unstarted' },
      { id: 'doing', label: 'Doing', color: 'blue', position: 1, category: 'started' },
      { id: 'closed', label: 'Closed', color: 'green', position: 2, category: 'completed' },
    ])
  })

  test('rejects repository feature integration without path', () => {
    expect(() => {
      h.invoke('db:projects:create', {
        name: 'Broken',
        color: '#ef4444',
        featureRepoIntegrationEnabled: true
      })
    }).toThrow()
  })

  test('rejects Features folder that escapes repository path', () => {
    const repoPath = h.tmpDir()
    expect(() => {
      h.invoke('db:projects:create', {
        name: 'Escaped',
        color: '#ef4444',
        path: repoPath,
        featureRepoIntegrationEnabled: true,
        featureRepoFeaturesPath: '../outside'
      })
    }).toThrow()
  })

  test('creates and syncs tasks from feature.yaml when integration is enabled', () => {
    const repoPath = h.tmpDir()
    writeFeatureYaml(
      repoPath,
      'docs/features/feature-001',
      `id: FEAT-001
title: Google Sheets Integration as a HubSpot Alternative (Backend)
description: |
  Users can connect a Google Sheets document as an alternative backend integration
  to HubSpot.
`
    )

    const project = h.invoke('db:projects:create', {
      name: 'Feature Synced Project',
      color: '#22c55e',
      path: repoPath,
      featureRepoIntegrationEnabled: true
    }) as { id: string }

    const tasks = h.db
      .prepare('SELECT title, description FROM tasks WHERE project_id = ? ORDER BY "order" ASC')
      .all(project.id) as Array<{ title: string; description: string | null }>
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe('FEAT-001 Google Sheets Integration as a HubSpot Alternative (Backend)')
    expect(Boolean(tasks[0].description?.includes('alternative backend integration'))).toBe(true)

    const links = h.db
      .prepare('SELECT feature_file_path FROM project_feature_task_links WHERE project_id = ?')
      .all(project.id) as Array<{ feature_file_path: string }>
    expect(links).toHaveLength(1)
    expect(links[0].feature_file_path).toBe('docs/features/feature-001/feature.yaml')
  })
})

describe('db:projects:getAll', () => {
  test('returns projects ordered by name', () => {
    const all = h.invoke('db:projects:getAll') as { name: string }[]
    expect(all[0].name).toBe('Alpha')
    expect(all[1].name).toBe('Beta')
  })
})

describe('db:projects:update', () => {
  test('updates name', () => {
    const all = h.invoke('db:projects:getAll') as { id: string }[]
    const p = h.invoke('db:projects:update', { id: all[0].id, name: 'Gamma' }) as { name: string }
    expect(p.name).toBe('Gamma')
  })

  test('updates path', () => {
    const all = h.invoke('db:projects:getAll') as { id: string }[]
    const p = h.invoke('db:projects:update', { id: all[1].id, path: '/tmp/new' }) as { path: string }
    expect(p.path).toBe('/tmp/new')
  })

  test('updates autoCreateWorktreeOnTaskCreate', () => {
    const all = h.invoke('db:projects:getAll') as { id: string }[]
    const p = h.invoke('db:projects:update', { id: all[0].id, autoCreateWorktreeOnTaskCreate: true }) as { auto_create_worktree_on_task_create: number }
    expect(p.auto_create_worktree_on_task_create).toBe(1)
  })

  test('updates repository feature integration settings', () => {
    const all = h.invoke('db:projects:getAll') as { id: string; name: string }[]
    const gamma = all.find(p => p.name === 'Gamma')!
    const p = h.invoke('db:projects:update', {
      id: gamma.id,
      featureRepoIntegrationEnabled: true,
      featureRepoFeaturesPath: 'custom/features'
    }) as { feature_repo_integration_enabled: number; feature_repo_features_path: string }
    expect(p.feature_repo_integration_enabled).toBe(1)
    expect(p.feature_repo_features_path).toBe('custom/features')
  })

  test('detaches linked feature tasks when integration is disabled', () => {
    const repoPath = h.tmpDir()
    writeFeatureYaml(
      repoPath,
      'docs/features/feature-detach',
      `id: FEAT-DETACH
title: Detach me
description: Task should remain, link should be removed
`
    )

    const project = h.invoke('db:projects:create', {
      name: 'Detach Project',
      color: '#334155',
      path: repoPath,
      featureRepoIntegrationEnabled: true
    }) as { id: string }

    const before = h.db
      .prepare('SELECT COUNT(*) as count FROM project_feature_task_links WHERE project_id = ?')
      .get(project.id) as { count: number }
    expect(before.count).toBe(1)

    const updated = h.invoke('db:projects:update', {
      id: project.id,
      featureRepoIntegrationEnabled: false
    }) as { feature_repo_integration_enabled: number }
    expect(updated.feature_repo_integration_enabled).toBe(0)

    const afterLinks = h.db
      .prepare('SELECT COUNT(*) as count FROM project_feature_task_links WHERE project_id = ?')
      .get(project.id) as { count: number }
    expect(afterLinks.count).toBe(0)

    const tasks = h.db
      .prepare('SELECT COUNT(*) as count FROM tasks WHERE project_id = ?')
      .get(project.id) as { count: number }
    expect(tasks.count).toBe(1)
  })
})

describe('db:projects:syncFeatures', () => {
  test('updates linked task title when feature file changes', () => {
    const repoPath = h.tmpDir()
    const relDir = 'docs/features/feature-002'
    writeFeatureYaml(
      repoPath,
      relDir,
      `id: FEAT-002
title: Initial title
description: Initial
`
    )

    const project = h.invoke('db:projects:create', {
      name: 'Sync Update Project',
      color: '#06b6d4',
      path: repoPath,
      featureRepoIntegrationEnabled: true
    }) as { id: string }

    writeFeatureYaml(
      repoPath,
      relDir,
      `id: FEAT-002
title: Updated title
description: Updated description
`
    )

    const sync = h.invoke('db:projects:syncFeatures', project.id) as { updated: number }
    expect(sync.updated).toBe(1)

    const task = h.db
      .prepare('SELECT title, description FROM tasks WHERE project_id = ?')
      .get(project.id) as { title: string; description: string | null }
    expect(task.title).toBe('FEAT-002 Updated title')
    expect(Boolean(task.description?.includes('Updated description'))).toBe(true)
  })
})

describe('repository feature integration settings', () => {
  test('returns and updates feature sync config', () => {
    const current = h.invoke('db:projects:getFeatureSyncConfig') as {
      defaultFeaturesPath: string
      pollIntervalSeconds: number
    }
    expect(current.defaultFeaturesPath.length > 0).toBe(true)
    expect(current.pollIntervalSeconds).toBeGreaterThan(0)

    const updated = h.invoke('db:projects:setFeatureSyncConfig', {
      defaultFeaturesPath: 'features',
      pollIntervalSeconds: 45
    }) as {
      defaultFeaturesPath: string
      pollIntervalSeconds: number
    }
    expect(updated.defaultFeaturesPath).toBe('features')
    expect(updated.pollIntervalSeconds).toBe(45)
  })

  test('normalizes feature sync poll interval bounds', () => {
    const low = h.invoke('db:projects:setFeatureSyncConfig', {
      pollIntervalSeconds: 1
    }) as { pollIntervalSeconds: number }
    expect(low.pollIntervalSeconds).toBe(5)

    const high = h.invoke('db:projects:setFeatureSyncConfig', {
      pollIntervalSeconds: 99999
    }) as { pollIntervalSeconds: number }
    expect(high.pollIntervalSeconds).toBe(3600)
  })

  test('syncAllFeatures aggregates enabled projects', () => {
    const repoPath = h.tmpDir()
    writeFeatureYaml(
      repoPath,
      'features/feat-a',
      `id: FEAT-A
title: A title
description: A description
`
    )
    h.invoke('db:projects:create', {
      name: 'Agg Project',
      color: '#f59e0b',
      path: repoPath,
      featureRepoIntegrationEnabled: true,
      featureRepoFeaturesPath: 'features'
    })

    const result = h.invoke('db:projects:syncAllFeatures') as {
      projects: number
      scanned: number
    }
    expect(result.projects).toBeGreaterThan(0)
    expect(result.scanned).toBeGreaterThan(0)
  })

  test('updates columns config', () => {
    const all = h.invoke('db:projects:getAll') as { id: string; name: string }[]
    const project = all.find((p) => p.name === 'Columns Project')!
    const taskId = crypto.randomUUID()
    h.db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, priority, "order")
      VALUES (?, ?, 'Needs remap', 'doing', 3, 0)
    `).run(taskId, project.id)

    const p = h.invoke('db:projects:update', {
      id: project.id,
      columnsConfig: [
        { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
        { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' },
      ]
    }) as { columns_config: ColumnConfig[] | null }
    expect(p.columns_config).toEqual([
      { id: 'todo', label: 'Todo', color: 'blue', position: 0, category: 'unstarted' },
      { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' },
    ])

    const remapped = h.db
      .prepare('SELECT status FROM tasks WHERE id = ?')
      .get(taskId) as { status: string }
    expect(remapped.status).toBe('todo')
  })

  test('clears columns config when set to null', () => {
    const all = h.invoke('db:projects:getAll') as { id: string; name: string }[]
    const project = all.find((p) => p.name === 'Columns Project')!
    const taskId = crypto.randomUUID()
    h.db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, priority, "order")
      VALUES (?, ?, 'Custom status task', 'custom_status', 3, 0)
    `).run(taskId, project.id)

    const p = h.invoke('db:projects:update', { id: project.id, columnsConfig: null }) as {
      columns_config: ColumnConfig[] | null
    }
    expect(p.columns_config).toBeNull()

    const remapped = h.db
      .prepare('SELECT status FROM tasks WHERE id = ?')
      .get(taskId) as { status: string }
    expect(remapped.status).toBe('inbox')
  })

  test('reconciles linear state mappings when columns config changes', () => {
    h.db.exec(`
      CREATE TABLE IF NOT EXISTS integration_project_mappings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        external_team_id TEXT NOT NULL,
        external_team_key TEXT NOT NULL,
        external_project_id TEXT DEFAULT NULL,
        sync_mode TEXT NOT NULL DEFAULT 'one_way',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS integration_state_mappings (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        project_mapping_id TEXT NOT NULL,
        local_status TEXT NOT NULL,
        state_id TEXT NOT NULL,
        state_type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(provider, project_mapping_id, local_status)
      );
    `)

    const all = h.invoke('db:projects:getAll') as { id: string; name: string }[]
    const project = all.find((p) => p.name === 'Columns Project')!
    const mappingId = crypto.randomUUID()
    h.db.prepare(`
      INSERT OR REPLACE INTO integration_project_mappings (
        id, project_id, provider, connection_id, external_team_id, external_team_key, external_project_id, sync_mode
      ) VALUES (?, ?, 'linear', 'conn-1', 'team-1', 'ENG', NULL, 'two_way')
    `).run(mappingId, project.id)
    h.db.prepare(`
      INSERT OR REPLACE INTO integration_state_mappings (
        id, provider, project_mapping_id, local_status, state_id, state_type
      ) VALUES
        (?, 'linear', ?, 'todo_old', 'st-unstarted', 'unstarted'),
        (?, 'linear', ?, 'done_old', 'st-completed', 'completed')
    `).run(crypto.randomUUID(), mappingId, crypto.randomUUID(), mappingId)

    h.invoke('db:projects:update', {
      id: project.id,
      columnsConfig: [
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'shipped', label: 'Shipped', color: 'green', position: 1, category: 'completed' },
      ]
    })

    const rows = h.db.prepare(`
      SELECT local_status, state_id, state_type
      FROM integration_state_mappings
      WHERE provider = 'linear' AND project_mapping_id = ?
      ORDER BY local_status
    `).all(mappingId) as Array<{ local_status: string; state_id: string; state_type: string }>

    expect(rows).toEqual([
      { local_status: 'queued', state_id: 'st-unstarted', state_type: 'unstarted' },
      { local_status: 'shipped', state_id: 'st-completed', state_type: 'completed' },
    ])
  })
})

describe('db:projects:delete', () => {
  test('deletes existing', () => {
    const p = h.invoke('db:projects:create', { name: 'Temp', color: '#000000' }) as { id: string }
    expect(h.invoke('db:projects:delete', p.id)).toBe(true)
  })

  test('returns false for nonexistent', () => {
    expect(h.invoke('db:projects:delete', 'nope')).toBe(false)
  })
})

h.cleanup()
console.log('\nDone')
