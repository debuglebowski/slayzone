/**
 * Task handler contract tests
 * Run with: npx tsx packages/domains/task/src/main/handlers.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerTaskHandlers, updateTask } from './handlers.js'
import { registerProjectHandlers } from '../../../projects/src/main/handlers.js'
import type { Task, ProviderConfig } from '../shared/types.js'
import fs from 'node:fs'
import path from 'node:path'

const h = await createTestHarness()
registerProjectHandlers(h.ipcMain as never, h.db)
registerTaskHandlers(h.ipcMain as never, h.db)

// Seed a project
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'TestProject', '#000', '/tmp/test')

// Helper
function createTask(title: string, extra?: Record<string, unknown>): Task {
  return h.invoke('db:tasks:create', { projectId, title, ...extra }) as Task
}

function writeFeatureMd(repoPath: string, relDir: string, content: string): void {
  const dir = path.join(repoPath, relDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'FEATURE.md'), content, 'utf8')
}

// --- CRUD ---

describe('db:tasks:create', () => {
  test('creates with defaults', () => {
    const t = createTask('First task')
    expect(t.title).toBe('First task')
    expect(t.status).toBe('inbox')
    expect(t.priority).toBe(3)
    expect(t.terminal_mode).toBe('claude-code')
    expect(t.project_id).toBe(projectId)
    expect(t.archived_at).toBeNull()
    expect(t.description).toBeNull()
  })

  test('creates with custom status and priority', () => {
    const t = createTask('Custom', { status: 'todo', priority: 1 })
    expect(t.status).toBe('todo')
    expect(t.priority).toBe(1)
  })

  test('normalizes unknown create status to the project default', () => {
    const customProjectId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
      customProjectId,
      'CreateStatusNormalize',
      '#777',
      '/tmp/create-status-normalize',
      JSON.stringify([
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'closed', label: 'Closed', color: 'green', position: 1, category: 'completed' },
      ])
    )

    const task = h.invoke('db:tasks:create', {
      projectId: customProjectId,
      title: 'Unknown status create',
      status: 'not_real'
    }) as Task

    expect(task.status).toBe('queued')
  })

  test('builds provider_config from defaults', () => {
    const t = createTask('WithConfig')
    expect(t.provider_config['claude-code']?.flags).toBe('--allow-dangerously-skip-permissions')
    expect(t.provider_config['codex']?.flags).toBe('--full-auto --search')
  })

  test('respects custom flags override', () => {
    const t = createTask('CustomFlags', { claudeFlags: '--verbose' })
    expect(t.provider_config['claude-code']?.flags).toBe('--verbose')
    // Other providers keep defaults
    expect(t.provider_config['codex']?.flags).toBe('--full-auto --search')
  })

  test('creates with parent_id', () => {
    const parent = createTask('Parent')
    const child = createTask('Child', { parentId: parent.id })
    expect(child.parent_id).toBe(parent.id)
  })

  test('uses project-specific default status from columns config', () => {
    const customProjectId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
      customProjectId,
      'ColumnsProject',
      '#111',
      '/tmp/custom',
      JSON.stringify([
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'progressing', label: 'Progressing', color: 'blue', position: 1, category: 'started' },
        { id: 'closed', label: 'Closed', color: 'green', position: 2, category: 'completed' },
      ])
    )
    const task = h.invoke('db:tasks:create', {
      projectId: customProjectId,
      title: 'Project-specific default',
    }) as Task
    expect(task.status).toBe('queued')
  })

  test('falls back to inbox when project columns config is invalid', () => {
    const invalidProjectId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
      invalidProjectId,
      'InvalidColumns',
      '#222',
      '/tmp/invalid',
      '{"not":"a-valid-columns-array"}'
    )
    const task = h.invoke('db:tasks:create', {
      projectId: invalidProjectId,
      title: 'Fallback default status',
    }) as Task
    expect(task.status).toBe('inbox')
  })
})

describe('db:tasks:get', () => {
  test('returns task by id', () => {
    const created = createTask('GetMe')
    const t = h.invoke('db:tasks:get', created.id) as Task
    expect(t.title).toBe('GetMe')
  })

  test('returns null for nonexistent', () => {
    expect(h.invoke('db:tasks:get', 'nope')).toBeNull()
  })
})

describe('db:tasks:getAll', () => {
  test('returns all tasks', () => {
    const all = h.invoke('db:tasks:getAll') as Task[]
    expect(all.length).toBeGreaterThan(0)
  })
})

describe('db:tasks:getByProject', () => {
  test('filters by project and excludes archived', () => {
    const tasks = h.invoke('db:tasks:getByProject', projectId) as Task[]
    for (const t of tasks) {
      expect(t.project_id).toBe(projectId)
      expect(t.archived_at).toBeNull()
    }
  })
})

describe('db:tasks:getSubTasks', () => {
  test('returns children', () => {
    const parent = createTask('SubParent')
    const c1 = createTask('Child1', { parentId: parent.id })
    const c2 = createTask('Child2', { parentId: parent.id })
    const subs = h.invoke('db:tasks:getSubTasks', parent.id) as Task[]
    expect(subs).toHaveLength(2)
    const ids = subs.map(s => s.id)
    expect(ids).toContain(c1.id)
    expect(ids).toContain(c2.id)
  })
})

// --- Update ---

describe('db:tasks:update', () => {
  test('updates title', () => {
    const t = createTask('Old')
    const updated = h.invoke('db:tasks:update', { id: t.id, title: 'New' }) as Task
    expect(updated.title).toBe('New')
  })

  test('updates status', () => {
    const t = createTask('StatusTest')
    const updated = h.invoke('db:tasks:update', { id: t.id, status: 'in_progress' }) as Task
    expect(updated.status).toBe('in_progress')
  })

  test('normalizes unknown update status to the project default', () => {
    const customProjectId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
      customProjectId,
      'UpdateStatusNormalize',
      '#888',
      '/tmp/update-status-normalize',
      JSON.stringify([
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'closed', label: 'Closed', color: 'green', position: 1, category: 'completed' },
      ])
    )
    const task = h.invoke('db:tasks:create', {
      projectId: customProjectId,
      title: 'Unknown status update'
    }) as Task
    const updated = h.invoke('db:tasks:update', { id: task.id, status: 'ghost' }) as Task

    expect(updated.status).toBe('queued')
  })

  test('updates to custom terminal status id', () => {
    const projectWithTerminal = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
      projectWithTerminal,
      'TerminalColumns',
      '#333',
      '/tmp/terminal',
      JSON.stringify([
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'wontfix', label: 'Wontfix', color: 'slate', position: 1, category: 'canceled' },
        { id: 'closed', label: 'Closed', color: 'green', position: 2, category: 'completed' },
      ])
    )
    const t = h.invoke('db:tasks:create', { projectId: projectWithTerminal, title: 'TerminalStatus' }) as Task
    const updated = h.invoke('db:tasks:update', { id: t.id, status: 'wontfix' }) as Task
    expect(updated.status).toBe('wontfix')
  })

  test('normalizes status when moving task to a project with different columns', () => {
    const sourceProjectId = crypto.randomUUID()
    const targetProjectId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
      sourceProjectId,
      'MoveSource',
      '#444',
      '/tmp/source',
      JSON.stringify([
        { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'doing', label: 'Doing', color: 'blue', position: 1, category: 'started' },
        { id: 'shipped', label: 'Shipped', color: 'green', position: 2, category: 'completed' },
      ])
    )
    h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
      targetProjectId,
      'MoveTarget',
      '#555',
      '/tmp/target',
      JSON.stringify([
        { id: 'triage', label: 'Triage', color: 'gray', position: 0, category: 'triage' },
        { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' },
      ])
    )

    const task = h.invoke('db:tasks:create', {
      projectId: sourceProjectId,
      title: 'Move me',
      status: 'doing'
    }) as Task
    const updated = h.invoke('db:tasks:update', {
      id: task.id,
      projectId: targetProjectId
    }) as Task

    expect(updated.project_id).toBe(targetProjectId)
    expect(updated.status).toBe('triage')
  })

  test('no-op returns current task', () => {
    const t = createTask('NoOp')
    const same = h.invoke('db:tasks:update', { id: t.id }) as Task
    expect(same.title).toBe('NoOp')
  })

  test('provider_config deep merge - conversationId', () => {
    const t = createTask('DeepMerge')
    // Set flags first
    expect(t.provider_config['claude-code']?.flags).toBe('--allow-dangerously-skip-permissions')

    // Update only conversationId — flags should survive
    const updated = h.invoke('db:tasks:update', {
      id: t.id,
      providerConfig: { 'claude-code': { conversationId: 'abc123' } }
    }) as Task
    expect(updated.provider_config['claude-code']?.conversationId).toBe('abc123')
    expect(updated.provider_config['claude-code']?.flags).toBe('--allow-dangerously-skip-permissions')
  })

  test('provider_config deep merge - partial mode update', () => {
    const t = createTask('PartialMerge')
    // Set codex conversationId
    h.invoke('db:tasks:update', {
      id: t.id,
      providerConfig: { codex: { conversationId: 'codex-1' } }
    })
    // Update claude-code only — codex should survive
    const updated = h.invoke('db:tasks:update', {
      id: t.id,
      providerConfig: { 'claude-code': { conversationId: 'claude-1' } }
    }) as Task
    expect(updated.provider_config['codex']?.conversationId).toBe('codex-1')
    expect(updated.provider_config['claude-code']?.conversationId).toBe('claude-1')
  })

  test('legacy fields update provider_config', () => {
    const t = createTask('LegacyUpdate')
    const updated = h.invoke('db:tasks:update', {
      id: t.id,
      claudeConversationId: 'legacy-id',
      claudeFlags: '--legacy-flag'
    }) as Task
    expect(updated.provider_config['claude-code']?.conversationId).toBe('legacy-id')
    expect(updated.provider_config['claude-code']?.flags).toBe('--legacy-flag')
    // Backfilled legacy columns
    expect(updated.claude_conversation_id).toBe('legacy-id')
    expect(updated.claude_flags).toBe('--legacy-flag')
  })

  test('updates JSON columns', () => {
    const t = createTask('JSONTest')
    const visibility = { terminal: true, browser: false, diff: false, settings: false, feature: false, editor: true, processes: false }
    const updated = h.invoke('db:tasks:update', {
      id: t.id,
      panelVisibility: visibility
    }) as Task
    expect(updated.panel_visibility?.terminal).toBe(true)
    expect(updated.panel_visibility?.browser).toBe(false)
  })

  test('updates worktree fields', () => {
    const t = createTask('Worktree')
    const updated = h.invoke('db:tasks:update', {
      id: t.id,
      worktreePath: '/tmp/wt',
      worktreeParentBranch: 'main'
    }) as Task
    expect(updated.worktree_path).toBe('/tmp/wt')
    expect(updated.worktree_parent_branch).toBe('main')
  })
})

describe('linked feature file sync', () => {
  test('updates linked FEATURE.md when task title/description change', () => {
    const repoPath = h.tmpDir()
    writeFeatureMd(
      repoPath,
      'docs/features/feature-101',
      `id: FEAT-101
title: Initial title
description: |
  Initial description
stories:
  - id: US-1
    title: Existing story
`
    )

    const project = h.invoke('db:projects:create', {
      name: 'Linked Project',
      color: '#0ea5e9',
      path: repoPath,
      featureRepoIntegrationEnabled: true
    }) as { id: string }

    const task = (h.invoke('db:tasks:getByProject', project.id) as Task[])[0]
    expect(task.title).toBe('FEAT-101 Initial title')

    h.invoke('db:tasks:update', {
      id: task.id,
      title: 'FEAT-101 Updated title',
      description: 'Updated description from task'
    })

    const featureFile = fs.readFileSync(
      path.join(repoPath, 'docs/features/feature-101/FEATURE.md'),
      'utf8'
    )
    expect(featureFile.includes('title: "Updated title"')).toBe(true)
    expect(featureFile.includes('Updated description from task')).toBe(true)
    expect(featureFile.includes('stories:')).toBe(true)
  })

  test('pulls latest PRD/spec title and description on task read', () => {
    const repoPath = h.tmpDir()
    writeFeatureMd(
      repoPath,
      'docs/features/feature-102',
      `id: FEAT-102
title: Initial sync title
description: |
  Initial sync description
`
    )

    const project = h.invoke('db:projects:create', {
      name: 'Read Sync Project',
      color: '#22c55e',
      path: repoPath,
      featureRepoIntegrationEnabled: true
    }) as { id: string }

    writeFeatureMd(
      repoPath,
      'docs/features/feature-102',
      `id: FEAT-102
title: Updated from repo
description: |
  Updated description from repo
`
    )

    const tasks = h.invoke('db:tasks:getByProject', project.id) as Task[]
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe('FEAT-102 Updated from repo')
    expect(tasks[0].description).toBeNull()
  })

  test('returns linked feature context for codex prompt bootstrap', () => {
    const repoPath = h.tmpDir()
    writeFeatureMd(
      repoPath,
      'docs/features/feature-103',
      `id: FEAT-103
title: Context source
description: |
  Source for context bootstrap
`
    )

    const project = h.invoke('db:projects:create', {
      name: 'Context Project',
      color: '#14b8a6',
      path: repoPath,
      featureRepoIntegrationEnabled: true
    }) as { id: string }

    const task = (h.invoke('db:tasks:getByProject', project.id) as Task[])[0]
    const context = h.invoke('db:tasks:getFeatureContext', task.id) as {
      featureFilePath: string
      featureDirPath: string
      featureDirAbsolutePath: string | null
    }

    expect(context.featureFilePath).toBe('docs/features/feature-103/FEATURE.md')
    expect(context.featureDirPath).toBe('docs/features/feature-103')
    expect(Boolean(context.featureDirAbsolutePath?.endsWith('docs/features/feature-103'))).toBe(true)
  })

  test('returns linked feature details with acceptance metadata', () => {
    const repoPath = h.tmpDir()
    writeFeatureMd(
      repoPath,
      'docs/features/feature-104',
      `id: FEAT-104
title: Feature panel test
description: |
  Feature panel metadata source
acceptance:
  - id: SC-US1-1
    scenario: Happy path
    file: acceptance/features/feature-104.feature
  - id: SC-US1-2
    scenario: Relative path
    file: ./acceptance/local.feature
`
    )

    const project = h.invoke('db:projects:create', {
      name: 'Feature Details Project',
      color: '#8b5cf6',
      path: repoPath,
      featureRepoIntegrationEnabled: true
    }) as { id: string }

    const task = (h.invoke('db:tasks:getByProject', project.id) as Task[])[0]
    const details = h.invoke('db:tasks:getFeatureDetails', task.id) as {
      featureId: string | null
      title: string
      featureFilePath: string
      featureDirPath: string
      acceptance: Array<{ id: string; scenario: string; file: string | null; resolvedFilePath: string | null }>
      lastSyncSource: 'repo' | 'task'
    }

    expect(details.featureId).toBe('FEAT-104')
    expect(details.title).toBe('Feature panel test')
    expect(details.featureFilePath).toBe('docs/features/feature-104/FEATURE.md')
    expect(details.featureDirPath).toBe('docs/features/feature-104')
    expect(details.acceptance).toHaveLength(2)
    expect(details.acceptance[0].id).toBe('SC-US1-1')
    expect(details.acceptance[0].scenario).toBe('Happy path')
    expect(details.acceptance[0].resolvedFilePath).toBe('acceptance/features/feature-104.feature')
    expect(details.acceptance[1].resolvedFilePath).toBe('docs/features/feature-104/acceptance/local.feature')
    expect(details.lastSyncSource).toBe('repo')
  })

  test('unlinks task feature details when linked FEATURE.md is deleted', () => {
    const repoPath = h.tmpDir()
    writeFeatureMd(
      repoPath,
      'docs/features/feature-missing',
      `id: FEAT-MISSING
title: Missing feature file
description: This feature file will be deleted
`
    )

    const project = h.invoke('db:projects:create', {
      name: 'Missing Feature Project',
      color: '#6d28d9',
      path: repoPath,
      featureRepoIntegrationEnabled: true
    }) as { id: string }

    const task = (h.invoke('db:tasks:getByProject', project.id) as Task[])[0]
    fs.rmSync(path.join(repoPath, 'docs/features/feature-missing'), { recursive: true, force: true })

    const details = h.invoke('db:tasks:getFeatureDetails', task.id) as null
    expect(details).toBeNull()

    const links = h.db
      .prepare('SELECT COUNT(*) as count FROM project_feature_task_links WHERE task_id = ?')
      .get(task.id) as { count: number }
    expect(links.count).toBe(0)
  })

  test('tracks last sync source for repo pull and task push', () => {
    const repoPath = h.tmpDir()
    writeFeatureMd(
      repoPath,
      'docs/features/feature-105',
      `id: FEAT-105
title: Sync source test
description: Initial
`
    )

    const project = h.invoke('db:projects:create', {
      name: 'Sync Source Project',
      color: '#f97316',
      path: repoPath,
      featureRepoIntegrationEnabled: true
    }) as { id: string }

    const task = (h.invoke('db:tasks:getByProject', project.id) as Task[])[0]

    h.invoke('db:tasks:update', {
      id: task.id,
      title: 'FEAT-105 Updated by task'
    })

    const afterPush = h.invoke('db:tasks:getFeatureDetails', task.id) as { lastSyncSource: 'repo' | 'task' }
    expect(afterPush.lastSyncSource).toBe('task')

    writeFeatureMd(
      repoPath,
      'docs/features/feature-105',
      `id: FEAT-105
title: Updated by repo
description: Updated by repo
`
    )
    h.invoke('db:tasks:syncFeatureFromRepo', task.id)

    const afterPull = h.invoke('db:tasks:getFeatureDetails', task.id) as { lastSyncSource: 'repo' | 'task' }
    expect(afterPull.lastSyncSource).toBe('repo')
  })

  test('creates and links a new feature file for an unlinked task', () => {
    const repoPath = h.tmpDir()
    const project = h.invoke('db:projects:create', {
      name: 'Create Feature Project',
      color: '#0ea5e9',
      path: repoPath,
      featureRepoIntegrationEnabled: true
    }) as { id: string }

    const task = h.invoke('db:tasks:create', {
      projectId: project.id,
      title: 'Build feature tab',
      description: 'Create feature from task panel'
    }) as Task

    const created = h.invoke('db:tasks:createFeature', task.id, {
      featureId: 'FEAT-200',
      folderName: 'feature-200',
      title: 'Feature Tab V2',
      description: 'Canonical feature description'
    }) as { created: boolean; featureFilePath: string; task: Task | null; details: { featureId: string | null } | null }

    expect(created.created).toBe(true)
    expect(created.featureFilePath).toBe('docs/features/feature-200/FEATURE.md')
    expect(created.details?.featureId).toBe('FEAT-200')
    expect(created.task?.title).toBe('FEAT-200 Feature Tab V2')
    expect(created.task?.description).toBe('Create feature from task panel')

    const featureFile = fs.readFileSync(
      path.join(repoPath, 'docs/features/feature-200/FEATURE.md'),
      'utf8'
    )
    expect(featureFile.includes('# Feature Tab V2')).toBe(true)
    expect(featureFile.includes('Canonical feature description')).toBe(true)
  })

  test('deletes linked feature directory and unlinks the task', () => {
    const repoPath = h.tmpDir()
    const project = h.invoke('db:projects:create', {
      name: 'Delete Feature Project',
      color: '#0891b2',
      path: repoPath,
      featureRepoIntegrationEnabled: true
    }) as { id: string }

    const task = h.invoke('db:tasks:create', {
      projectId: project.id,
      title: 'Delete linked feature'
    }) as Task

    h.invoke('db:tasks:createFeature', task.id, {
      featureId: 'FEAT-301',
      folderName: 'feature-301',
      title: 'Delete me'
    })

    fs.writeFileSync(
      path.join(repoPath, 'docs/features/feature-301', 'notes.md'),
      '# extra file',
      'utf8'
    )

    const deleted = h.invoke('db:tasks:deleteFeature', task.id) as {
      deleted: boolean
      details: unknown | null
    }

    expect(deleted.deleted).toBe(true)
    expect(deleted.details).toBeNull()
    expect(fs.existsSync(path.join(repoPath, 'docs/features/feature-301'))).toBe(false)
    expect(h.invoke('db:tasks:getFeatureDetails', task.id)).toBeNull()
  })

  test('updates linked FEATURE.md from editable feature payload', () => {
    const repoPath = h.tmpDir()
    writeFeatureMd(
      repoPath,
      'docs/features/feature-201',
      `id: "FEAT-201"
title: "Original title"
description: |
  Original description
acceptance:
  - id: SC-US1-1
    scenario: Original scenario
    file: acceptance/features/original.feature
`
    )

    const project = h.invoke('db:projects:create', {
      name: 'Editable Feature Project',
      color: '#7c3aed',
      path: repoPath,
      featureRepoIntegrationEnabled: true
    }) as { id: string }

    const task = (h.invoke('db:tasks:getByProject', project.id) as Task[])[0]
    const updated = h.invoke('db:tasks:updateFeature', task.id, {
      featureId: 'FEAT-201',
      title: 'Edited title',
      description: 'Edited description',
      acceptance: [
        {
          id: 'SC-US1-1',
          scenario: 'Edited scenario',
          file: 'acceptance/features/edited.feature'
        },
        {
          id: 'SC-US1-2',
          scenario: 'Second scenario',
          file: 'acceptance/features/second.feature'
        }
      ]
    }) as { updated: boolean; task: Task; details: { title: string; description: string | null; acceptance: Array<{ id: string }> } }

    expect(updated.updated).toBe(true)
    expect(updated.task.title).toBe('FEAT-201 Edited title')
    expect(updated.details.title).toBe('Edited title')
    expect(updated.details.description).toBe('Edited description')
    expect(updated.details.acceptance).toHaveLength(2)
    expect(updated.details.acceptance[1].id).toBe('SC-US1-2')

    const featureFile = fs.readFileSync(
      path.join(repoPath, 'docs/features/feature-201/FEATURE.md'),
      'utf8'
    )
    expect(featureFile.includes('id: "FEAT-201"')).toBe(true)
    expect(featureFile.includes('title: "Edited title"')).toBe(true)
    expect(featureFile.includes('description: |')).toBe(true)
    expect(featureFile.includes('Edited description')).toBe(true)
    expect(featureFile.includes('acceptance:')).toBe(true)
    expect(featureFile.includes('scenario: "Second scenario"')).toBe(true)
  })
})

// --- Archive ---

describe('db:tasks:archive', () => {
  test('sets archived_at', () => {
    const t = createTask('ToArchive')
    const archived = h.invoke('db:tasks:archive', t.id) as Task
    expect(archived.archived_at).toBeTruthy()
  })

  test('clears worktree_path', () => {
    const t = createTask('WTArchive')
    h.invoke('db:tasks:update', { id: t.id, worktreePath: '/tmp/wt' })
    const archived = h.invoke('db:tasks:archive', t.id) as Task
    expect(archived.worktree_path).toBeNull()
  })

  test('cascades to sub-tasks', () => {
    const parent = createTask('ArchiveParent')
    const child = createTask('ArchiveChild', { parentId: parent.id })
    h.invoke('db:tasks:archive', parent.id)
    const childAfter = h.invoke('db:tasks:get', child.id) as Task
    expect(childAfter.archived_at).toBeTruthy()
  })
})

describe('db:tasks:archiveMany', () => {
  test('archives multiple', () => {
    const t1 = createTask('AM1')
    const t2 = createTask('AM2')
    h.invoke('db:tasks:archiveMany', [t1.id, t2.id])
    expect((h.invoke('db:tasks:get', t1.id) as Task).archived_at).toBeTruthy()
    expect((h.invoke('db:tasks:get', t2.id) as Task).archived_at).toBeTruthy()
  })

  test('no-ops on empty array', () => {
    h.invoke('db:tasks:archiveMany', [])
    // Should not throw
  })
})

describe('db:tasks:unarchive', () => {
  test('clears archived_at', () => {
    const t = createTask('Unarchive')
    h.invoke('db:tasks:archive', t.id)
    const restored = h.invoke('db:tasks:unarchive', t.id) as Task
    expect(restored.archived_at).toBeNull()
  })
})

describe('db:tasks:getArchived', () => {
  test('returns only archived tasks', () => {
    const archived = h.invoke('db:tasks:getArchived') as Task[]
    for (const t of archived) {
      expect(t.archived_at).toBeTruthy()
    }
  })
})

// --- Reorder ---

describe('db:tasks:reorder', () => {
  test('sets order column', () => {
    const t1 = createTask('R1')
    const t2 = createTask('R2')
    const t3 = createTask('R3')
    h.invoke('db:tasks:reorder', [t3.id, t1.id, t2.id])
    expect((h.invoke('db:tasks:get', t3.id) as Task).order).toBe(0)
    expect((h.invoke('db:tasks:get', t1.id) as Task).order).toBe(1)
    expect((h.invoke('db:tasks:get', t2.id) as Task).order).toBe(2)
  })
})

// --- Delete ---

describe('db:tasks:delete', () => {
  test('deletes task', () => {
    const t = createTask('ToDelete')
    expect(h.invoke('db:tasks:delete', t.id)).toBe(true)
    expect(h.invoke('db:tasks:get', t.id)).toBeNull()
  })

  test('deletes linked feature directory when task has attached feature', () => {
    const repoPath = h.tmpDir()
    const project = h.invoke('db:projects:create', {
      name: 'Delete Task With Feature Project',
      color: '#10b981',
      path: repoPath,
      featureRepoIntegrationEnabled: true
    }) as { id: string }

    const task = h.invoke('db:tasks:create', {
      projectId: project.id,
      title: 'Task with attached feature'
    }) as Task

    h.invoke('db:tasks:createFeature', task.id, {
      featureId: 'FEAT-401',
      folderName: 'feature-401',
      title: 'Delete on task delete'
    })

    fs.writeFileSync(
      path.join(repoPath, 'docs/features/feature-401', 'notes.md'),
      '# feature notes',
      'utf8'
    )

    expect(h.invoke('db:tasks:delete', task.id, { deleteFeatureDir: true })).toBe(true)
    expect(fs.existsSync(path.join(repoPath, 'docs/features/feature-401'))).toBe(false)

    const remainingLinks = h.db
      .prepare('SELECT COUNT(*) as count FROM project_feature_task_links WHERE task_id = ?')
      .get(task.id) as { count: number }
    expect(remainingLinks.count).toBe(0)
  })

  test('keeps linked feature directory when deleteFeatureDir option is not set', () => {
    const repoPath = h.tmpDir()
    const project = h.invoke('db:projects:create', {
      name: 'Delete Task Keep Feature Project',
      color: '#10b981',
      path: repoPath,
      featureRepoIntegrationEnabled: true
    }) as { id: string }

    const task = h.invoke('db:tasks:create', {
      projectId: project.id,
      title: 'Task with attached feature kept'
    }) as Task

    h.invoke('db:tasks:createFeature', task.id, {
      featureId: 'FEAT-402',
      folderName: 'feature-402',
      title: 'Keep on task delete'
    })

    expect(h.invoke('db:tasks:delete', task.id)).toBe(true)
    expect(fs.existsSync(path.join(repoPath, 'docs/features/feature-402'))).toBe(true)

    const remainingLinks = h.db
      .prepare('SELECT COUNT(*) as count FROM project_feature_task_links WHERE task_id = ?')
      .get(task.id) as { count: number }
    expect(remainingLinks.count).toBe(1)
  })

  test('returns false for nonexistent', () => {
    expect(h.invoke('db:tasks:delete', 'nope')).toBe(false)
  })
})

// --- Dependencies ---

describe('db:taskDependencies', () => {
  test('addBlocker + getBlockers', () => {
    const t1 = createTask('Blocked')
    const t2 = createTask('Blocker')
    h.invoke('db:taskDependencies:addBlocker', t1.id, t2.id)
    const blockers = h.invoke('db:taskDependencies:getBlockers', t1.id) as Task[]
    expect(blockers).toHaveLength(1)
    expect(blockers[0].id).toBe(t2.id)
  })

  test('getBlocking', () => {
    const t1 = createTask('A')
    const t2 = createTask('B')
    h.invoke('db:taskDependencies:addBlocker', t2.id, t1.id)
    const blocking = h.invoke('db:taskDependencies:getBlocking', t1.id) as Task[]
    expect(blocking).toHaveLength(1)
    expect(blocking[0].id).toBe(t2.id)
  })

  test('removeBlocker', () => {
    const t1 = createTask('X')
    const t2 = createTask('Y')
    h.invoke('db:taskDependencies:addBlocker', t1.id, t2.id)
    h.invoke('db:taskDependencies:removeBlocker', t1.id, t2.id)
    const blockers = h.invoke('db:taskDependencies:getBlockers', t1.id) as Task[]
    expect(blockers).toHaveLength(0)
  })

  test('setBlockers replaces all', () => {
    const t = createTask('Main')
    const b1 = createTask('B1')
    const b2 = createTask('B2')
    const b3 = createTask('B3')
    h.invoke('db:taskDependencies:addBlocker', t.id, b1.id)
    h.invoke('db:taskDependencies:setBlockers', t.id, [b2.id, b3.id])
    const blockers = h.invoke('db:taskDependencies:getBlockers', t.id) as Task[]
    expect(blockers).toHaveLength(2)
    const ids = blockers.map(b => b.id)
    expect(ids).toContain(b2.id)
    expect(ids).toContain(b3.id)
  })

  test('addBlocker is idempotent (INSERT OR IGNORE)', () => {
    const t1 = createTask('Idem1')
    const t2 = createTask('Idem2')
    h.invoke('db:taskDependencies:addBlocker', t1.id, t2.id)
    h.invoke('db:taskDependencies:addBlocker', t1.id, t2.id) // no-op
    const blockers = h.invoke('db:taskDependencies:getBlockers', t1.id) as Task[]
    expect(blockers).toHaveLength(1)
  })

})

h.cleanup()
console.log('\nDone')
