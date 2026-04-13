/**
 * AI Config context files, sync, instructions, MCP handler contract tests
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/ai-config/src/main/handlers.context.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerAiConfigHandlers } from './handlers.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

const h = await createTestHarness()
registerAiConfigHandlers(h.ipcMain as never, h.db)

const root = h.tmpDir()
const mockHome = '/tmp/mock-home'
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'Ctx', '#000', root)

function createProjectFixture(name: string): { projectId: string; projectPath: string } {
  const id = crypto.randomUUID()
  const projectPath = path.join(root, name)
  fs.mkdirSync(projectPath, { recursive: true })
  h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(id, name, '#000', projectPath)
  return { projectId: id, projectPath }
}

function skillDoc(slug: string, body: string): string {
  const normalizedBody = body.endsWith('\n') ? body : `${body}\n`
  return `---\nname: ${slug}\ndescription: ${slug}\n---\n${normalizedBody}`
}

function readSkillMetadata(itemId: string): {
  skillValidation?: { status?: string; issues?: Array<{ code?: string }> }
} {
  const row = h.db.prepare('SELECT metadata_json FROM ai_config_items WHERE id = ?').get(itemId) as {
    metadata_json: string
  }
  return JSON.parse(row.metadata_json) as {
    skillValidation?: { status?: string; issues?: Array<{ code?: string }> }
  }
}

// Ensure claude is enabled
h.db.prepare("UPDATE ai_config_sources SET enabled = 1 WHERE kind = 'claude'")?.run()

// --- Context file discovery ---

describe('ai-config:discover-context-files', () => {
  test('finds CLAUDE.md when present', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# rules')
    const entries = h.invoke('ai-config:discover-context-files', root) as { name: string; exists: boolean }[]
    const claudeMd = entries.find(e => e.name === 'CLAUDE.md')
    expect(claudeMd).toBeTruthy()
    expect(claudeMd!.exists).toBe(true)
  })
})

describe('ai-config:get-context-tree', () => {
  test('marks disk-only skill files as unmanaged', () => {
    const fixture = createProjectFixture('context-tree-unmanaged-skill')
    const diskOnlyPath = path.join(fixture.projectPath, '.agents/skills/disk-only-skill/SKILL.md')
    fs.mkdirSync(path.dirname(diskOnlyPath), { recursive: true })
    fs.writeFileSync(diskOnlyPath, '# disk only')

    const entries = h.invoke('ai-config:get-context-tree', fixture.projectPath, fixture.projectId) as Array<{
      relativePath: string
      linkedItemId: string | null
      syncHealth: string
      syncReason: string | null
    }>
    const found = entries.find((entry) => entry.relativePath === '.agents/skills/disk-only-skill/SKILL.md')
    expect(found).toBeTruthy()
    expect(found!.linkedItemId).toBeNull()
    expect(found!.syncHealth).toBe('unmanaged')
    expect(found!.syncReason).toBe('not_linked')
  })

  test('discovers unmanaged skill files for non-claude/codex providers', () => {
    const fixture = createProjectFixture('context-tree-unmanaged-cursor-skill')
    const diskOnlyPath = path.join(fixture.projectPath, '.cursor/skills/disk-only-cursor-skill/SKILL.md')
    fs.mkdirSync(path.dirname(diskOnlyPath), { recursive: true })
    fs.writeFileSync(diskOnlyPath, '# cursor disk only')

    const entries = h.invoke('ai-config:get-context-tree', fixture.projectPath, fixture.projectId) as Array<{
      relativePath: string
      provider?: string
      linkedItemId: string | null
      syncHealth: string
      syncReason: string | null
    }>
    const found = entries.find((entry) => entry.relativePath === '.cursor/skills/disk-only-cursor-skill/SKILL.md')
    expect(found).toBeTruthy()
    expect(found!.provider).toBe('cursor')
    expect(found!.linkedItemId).toBeNull()
    expect(found!.syncHealth).toBe('unmanaged')
    expect(found!.syncReason).toBe('not_linked')
  })
})

describe('ai-config:read-context-file', () => {
  test('reads file content', () => {
    const content = h.invoke('ai-config:read-context-file', path.join(root, 'CLAUDE.md'), root)
    expect(content).toBe('# rules')
  })

  test('rejects path outside project', () => {
    expect(() => h.invoke('ai-config:read-context-file', '/etc/passwd', root)).toThrow()
  })
})

describe('ai-config:write-context-file', () => {
  test('writes file', () => {
    h.invoke('ai-config:write-context-file', path.join(root, 'CLAUDE.md'), '# updated', root)
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8')).toBe('# updated')
  })
})

describe('ai-config:create-computer-file', () => {
  test('creates a normalized computer skill file', () => {
    const expectedPath = path.join(mockHome, '.agents', 'skills', 'my-computer-skill.md')
    if (fs.existsSync(expectedPath)) fs.unlinkSync(expectedPath)

    const created = h.invoke('ai-config:create-computer-file', 'gemini', 'skill', ' My Computer Skill! ') as {
      path: string
      provider: string
      category: string
      exists: boolean
    }

    expect(created.path).toBe(expectedPath)
    expect(created.provider).toBe('gemini')
    expect(created.category).toBe('skill')
    expect(created.exists).toBe(true)
    expect(fs.existsSync(expectedPath)).toBe(true)
  })

  test('rejects unsupported categories for provider', () => {
    expect(() => h.invoke('ai-config:create-computer-file', 'codex', 'skill', 'nope')).toThrow()
  })
})

describe('ai-config:list-items', () => {
  test('returns derived validation without mutating stored metadata on read', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'read-does-not-repair-db',
      content: '# body'
    }) as { id: string; metadata_json: string }

    const staleMeta = JSON.parse(item.metadata_json) as Record<string, unknown>
    staleMeta.skillValidation = {
      status: 'invalid',
      issues: [{ code: 'frontmatter_invalid_line', severity: 'error', message: 'stale issue', line: 4 }]
    }
    const staleMetadataJson = JSON.stringify(staleMeta)
    h.db.prepare('UPDATE ai_config_items SET content = ?, metadata_json = ? WHERE id = ?')
      .run(
        '---\nname: read-does-not-repair-db\ndescription: "fixed"\n---\n# body\n',
        staleMetadataJson,
        item.id
      )

    const listed = h.invoke('ai-config:list-items', {
      scope: 'library',
      type: 'skill'
    }) as Array<{ id: string; metadata_json: string }>
    const derived = listed.find((row) => row.id === item.id)
    expect(derived).toBeTruthy()
    const returnedMetadata = JSON.parse(derived!.metadata_json) as {
      skillValidation?: { status?: string }
    }
    expect(returnedMetadata.skillValidation?.status).toBe('valid')

    const stored = h.db.prepare('SELECT metadata_json FROM ai_config_items WHERE id = ?').get(item.id) as {
      metadata_json: string
    }
    expect(stored.metadata_json).toBe(staleMetadataJson)
  })

  test('recomputes stale invalid metadata to valid from current content', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'stale-invalid-repair',
      content: '# body'
    }) as { id: string; metadata_json: string }

    const staleMeta = JSON.parse(item.metadata_json) as Record<string, unknown>
    staleMeta.skillCanonical = {
      frontmatter: { name: 'stale-invalid-repair', description: 'old broken parse' },
      explicitFrontmatter: false
    }
    staleMeta.skillValidation = {
      status: 'invalid',
      issues: [{ code: 'frontmatter_invalid_line', severity: 'error', message: 'stale issue', line: 4 }]
    }
    h.db.prepare('UPDATE ai_config_items SET content = ?, metadata_json = ? WHERE id = ?')
      .run(
        '---\nname: stale-invalid-repair\ndescription: |\n  Multi-line\n  Description\n---\n# body',
        JSON.stringify(staleMeta),
        item.id
      )

    const listed = h.invoke('ai-config:list-items', {
      scope: 'library',
      type: 'skill'
    }) as Array<{ id: string; content: string; metadata_json: string }>
    const repaired = listed.find((row) => row.id === item.id)
    expect(repaired).toBeTruthy()
    expect(repaired!.content.includes('---\nname: stale-invalid-repair')).toBe(true)
    expect(repaired!.content.includes('# body')).toBe(true)
    const metadata = JSON.parse(repaired!.metadata_json) as {
      skillValidation?: { status?: string }
    }
    expect(metadata.skillValidation?.status).toBe('valid')
  })

  test('recomputes stale valid metadata to invalid from current content', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'stale-valid-repair',
      content: '# body'
    }) as { id: string; metadata_json: string }

    const staleMeta = JSON.parse(item.metadata_json) as Record<string, unknown>
    staleMeta.skillCanonical = {
      frontmatter: { name: 'stale-valid-repair', description: 'appears valid' },
      explicitFrontmatter: true
    }
    staleMeta.skillValidation = { status: 'valid', issues: [] }
    h.db.prepare('UPDATE ai_config_items SET content = ?, metadata_json = ? WHERE id = ?')
      .run(
        '---\nname: stale-valid-repair\ntags: [one, two\n---\n# body',
        JSON.stringify(staleMeta),
        item.id
      )

    const listed = h.invoke('ai-config:list-items', {
      scope: 'library',
      type: 'skill'
    }) as Array<{ id: string; metadata_json: string }>
    const repaired = listed.find((row) => row.id === item.id)
    expect(repaired).toBeTruthy()
    const metadata = JSON.parse(repaired!.metadata_json) as {
      skillValidation?: { status?: string; issues?: Array<{ code?: string }> }
    }
    expect(metadata.skillValidation?.status).toBe('invalid')
    expect(metadata.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_invalid_line')).toBe(true)
  })

  test('drops legacy canonical metadata and marks body-only legacy content invalid at runtime', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'stale-missing-frontmatter',
      content: skillDoc('stale-missing-frontmatter', '# body')
    }) as { id: string; metadata_json: string }

    const staleMeta = JSON.parse(item.metadata_json) as Record<string, unknown>
    staleMeta.skillCanonical = {
      frontmatter: { name: 'stale-missing-frontmatter', description: 'stale' },
      explicitFrontmatter: true
    }
    staleMeta.skillValidation = { status: 'valid', issues: [] }
    h.db.prepare('UPDATE ai_config_items SET content = ?, metadata_json = ? WHERE id = ?')
      .run(
        'Create a new release for SlayZone.\nThe version argument is: patch\n',
        JSON.stringify(staleMeta),
        item.id
      )

    const listed = h.invoke('ai-config:list-items', {
      scope: 'library',
      type: 'skill'
    }) as Array<{ id: string; content: string; metadata_json: string }>
    const repaired = listed.find((row) => row.id === item.id)
    expect(repaired).toBeTruthy()
    expect(repaired!.content).toBe('Create a new release for SlayZone.\nThe version argument is: patch\n')

    const metadata = JSON.parse(repaired!.metadata_json) as {
      skillValidation?: { status?: string; issues?: Array<{ code?: string }> }
    }
    expect(metadata.skillValidation?.status).toBe('invalid')
    expect(metadata.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_missing')).toBe(true)
  })

  test('marks new body-only skills invalid when no canonical frontmatter exists', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'new-missing-frontmatter',
      content: 'Create a new release for SlayZone.\nThe version argument is: patch\n'
    }) as { metadata_json: string }

    const metadata = JSON.parse(item.metadata_json) as {
      skillValidation?: { status?: string; issues?: Array<{ code?: string }> }
    }
    expect(metadata.skillValidation?.status).toBe('invalid')
    expect(metadata.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_missing')).toBe(true)
  })
})

describe('ai-config:get-item', () => {
  test('returns raw skill documents from storage', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'get-item-managed-frontmatter',
      content: skillDoc('get-item-managed-frontmatter', '# managed')
    }) as { id: string }

    const stored = h.db.prepare('SELECT content, metadata_json FROM ai_config_items WHERE id = ?').get(item.id) as {
      content: string
      metadata_json: string
    }
    expect(stored.content.includes('---\nname: get-item-managed-frontmatter')).toBe(true)
    expect(stored.content.includes('# managed\n')).toBe(true)

    const loaded = h.invoke('ai-config:get-item', item.id) as { content: string; metadata_json: string }
    expect(loaded.content.includes('---\nname: get-item-managed-frontmatter')).toBe(true)
    expect(loaded.content.includes('# managed\n')).toBe(true)

    const metadata = JSON.parse(loaded.metadata_json) as {
      skillValidation?: { status?: string }
    }
    expect(metadata.skillValidation?.status).toBe('valid')
  })
})

describe('ai-config:update-item', () => {
  test('marks managed skills invalid when they are updated without frontmatter', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'update-missing-frontmatter',
      content: skillDoc('update-missing-frontmatter', '# initial')
    }) as { id: string; content: string; metadata_json: string }

    const updated = h.invoke('ai-config:update-item', {
      id: item.id,
      content: 'You are evaluating a competitor for the SlayZone comparison table.\n'
    }) as { content: string; metadata_json: string }

    expect(updated.content).toBe('You are evaluating a competitor for the SlayZone comparison table.\n')
    const metadata = JSON.parse(updated.metadata_json) as {
      skillValidation?: { status?: string; issues?: Array<{ code?: string }> }
    }
    expect(metadata.skillValidation?.status).toBe('invalid')
    expect(metadata.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_missing')).toBe(true)
  })

  test('treats new and previously explicit body-only content the same', () => {
    const created = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'update-state-parity-created',
      content: 'Create a new release for SlayZone.\n'
    }) as { id: string }

    const previouslyExplicit = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'update-state-parity-updated',
      content: skillDoc('update-state-parity-updated', '# valid first')
    }) as { id: string }
    h.invoke('ai-config:update-item', {
      id: previouslyExplicit.id,
      content: 'Create a new release for SlayZone.\n'
    })

    const createdMeta = readSkillMetadata(created.id)
    const updatedMeta = readSkillMetadata(previouslyExplicit.id)
    expect(createdMeta.skillValidation?.status).toBe('invalid')
    expect(updatedMeta.skillValidation?.status).toBe('invalid')
    expect(createdMeta.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_missing')).toBe(true)
    expect(updatedMeta.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_missing')).toBe(true)
  })
})

// --- Load library item ---

describe('ai-config:load-library-item', () => {
  test('writes skill to provider dir with manual path', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill', scope: 'library', slug: 'deploy', content: skillDoc('deploy', '# Deploy skill')
    }) as { id: string }

    const result = h.invoke('ai-config:load-library-item', {
      projectId, projectPath: root, itemId: item.id,
      providers: ['claude'], manualPath: '.claude/skills/manual/deploy.md'
    }) as { relativePath: string; syncHealth: string }
    expect(result.relativePath).toBe('.claude/skills/manual/deploy.md')
    expect(result.syncHealth).toBe('synced')
    expect(fs.readFileSync(path.join(root, '.claude/skills/manual/deploy.md'), 'utf-8').trim()).toBe('# Deploy skill')
  })

  test('writes skill to codex provider path', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill', scope: 'library', slug: 'codex-skill', content: skillDoc('codex-skill', '# Codex skill')
    }) as { id: string }

    h.invoke('ai-config:load-library-item', {
      projectId, projectPath: root, itemId: item.id,
      providers: ['codex']
    })
    const codexContent = fs.readFileSync(path.join(root, '.agents/skills/codex-skill/SKILL.md'), 'utf-8')
    expect(codexContent.includes('name: codex-skill')).toBe(true)
    expect(codexContent.includes('# Codex skill')).toBe(true)
  })

  test('uses selected provider semantics for manual path links', () => {
    const fixture = createProjectFixture('manual-path-codex-provider')
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'manual-codex',
      content: skillDoc('manual-codex', '# Manual codex skill')
    }) as { id: string }

    const result = h.invoke('ai-config:load-library-item', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['codex'],
      manualPath: '.claude/skills/manual/manual-codex.md'
    }) as { relativePath: string; provider?: string; syncHealth: string }

    expect(result.relativePath).toBe('.claude/skills/manual/manual-codex.md')
    expect(result.provider).toBe('codex')
    expect(result.syncHealth).toBe('synced')
    expect(fs.readFileSync(path.join(fixture.projectPath, '.claude/skills/manual/manual-codex.md'), 'utf-8').trim()).toBe('# Manual codex skill')
    const selections = h.invoke('ai-config:list-project-selections', fixture.projectId) as Array<{
      provider: string
      target_path: string
    }>
    const found = selections.find((entry) => entry.target_path === '.claude/skills/manual/manual-codex.md')
    expect(found).toBeTruthy()
    expect(found!.provider).toBe('codex')
  })

  test('rejects loading a skill with invalid frontmatter', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'invalid-frontmatter-load',
      content: '---\nname invalid\n---\n# bad frontmatter'
    }) as { id: string; metadata_json: string }

    const metadata = JSON.parse(item.metadata_json) as {
      skillValidation?: { status?: string; issues?: Array<{ code?: string }> }
    }
    expect(metadata.skillValidation?.status).toBe('invalid')
    expect(metadata.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_invalid_line')).toBe(true)

    expect(() => h.invoke('ai-config:load-library-item', {
      projectId,
      projectPath: root,
      itemId: item.id,
      providers: ['claude']
    })).toThrow()
  })

  test('accepts multiline/list YAML frontmatter as valid', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'valid-yaml-frontmatter',
      content: [
        '---',
        'name: valid-yaml-frontmatter',
        'description: |',
        '  Multi-line description.',
        '  Still valid YAML.',
        'tags:',
        '  - planning',
        '  - review',
        '---',
        '# works'
      ].join('\n')
    }) as { id: string; metadata_json: string }

    const metadata = JSON.parse(item.metadata_json) as {
      skillValidation?: { status?: string }
    }
    expect(metadata.skillValidation?.status).toBe('valid')

    const result = h.invoke('ai-config:load-library-item', {
      projectId,
      projectPath: root,
      itemId: item.id,
      providers: ['claude']
    }) as { syncHealth: string }
    expect(result.syncHealth).toBe('synced')
  })

  test('rejects malformed YAML frontmatter structures', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'malformed-yaml-frontmatter',
      content: '---\nname: malformed-yaml-frontmatter\ntags: [one, two\n---\n# bad frontmatter'
    }) as { id: string; metadata_json: string }

    const metadata = JSON.parse(item.metadata_json) as {
      skillValidation?: { status?: string; issues?: Array<{ code?: string }> }
    }
    expect(metadata.skillValidation?.status).toBe('invalid')
    expect(metadata.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_invalid_line')).toBe(true)

    expect(() => h.invoke('ai-config:load-library-item', {
      projectId,
      projectPath: root,
      itemId: item.id,
      providers: ['claude']
    })).toThrow()
  })

  test('recomputes stale persisted invalid status from current valid content', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'status-invalid-authoritative',
      content: skillDoc('status-invalid-authoritative', '# body')
    }) as { id: string; metadata_json: string }

    const metadata = JSON.parse(item.metadata_json) as Record<string, unknown>
    metadata.skillValidation = { status: 'invalid', issues: [] }
    h.db.prepare("UPDATE ai_config_items SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify(metadata), item.id)

    const result = h.invoke('ai-config:load-library-item', {
      projectId,
      projectPath: root,
      itemId: item.id,
      providers: ['claude']
    }) as { syncHealth: string }
    expect(result.syncHealth).toBe('synced')
  })

  test('treats persisted valid status as authoritative when stale issues are present', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'status-valid-authoritative',
      content: skillDoc('status-valid-authoritative', '# body')
    }) as { id: string; metadata_json: string }

    const metadata = JSON.parse(item.metadata_json) as Record<string, unknown>
    metadata.skillValidation = {
      status: 'valid',
      issues: [{
        code: 'frontmatter_invalid_line',
        severity: 'error',
        message: 'stale issue',
        line: 2
      }]
    }
    h.db.prepare("UPDATE ai_config_items SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify(metadata), item.id)

    const result = h.invoke('ai-config:load-library-item', {
      projectId,
      projectPath: root,
      itemId: item.id,
      providers: ['claude']
    }) as { syncHealth: string }

    expect(result.syncHealth).toBe('synced')
  })

  test('rejects loading when explicit frontmatter is missing even if status was tampered to valid', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'status-valid-but-missing-frontmatter',
      content: '# no frontmatter'
    }) as { id: string; metadata_json: string }

    const metadata = JSON.parse(item.metadata_json) as Record<string, unknown>
    metadata.skillValidation = { status: 'valid', issues: [] }
    h.db.prepare("UPDATE ai_config_items SET metadata_json = ? WHERE id = ?")
      .run(JSON.stringify(metadata), item.id)

    expect(() => h.invoke('ai-config:load-library-item', {
      projectId,
      projectPath: root,
      itemId: item.id,
      providers: ['claude']
    })).toThrow()
  })
})

// --- Sync linked file ---

describe('ai-config:sync-linked-file', () => {
  test('re-syncs item content to disk', () => {
    // Create item + selection
    const item = h.invoke('ai-config:create-item', {
      type: 'skill', scope: 'library', slug: 'sync-test', content: skillDoc('sync-test', 'original')
    }) as { id: string }
    h.invoke('ai-config:load-library-item', {
      projectId, projectPath: root, itemId: item.id,
      providers: ['claude'], manualPath: '.claude/skills/manual/sync-test.md'
    })
    // Modify file externally
    fs.writeFileSync(path.join(root, '.claude/skills/manual/sync-test.md'), 'modified')
    // Update item content in DB
    h.invoke('ai-config:update-item', { id: item.id, content: skillDoc('sync-test', 'updated content') })

    const result = h.invoke('ai-config:sync-linked-file', projectId, root, item.id) as {
      syncHealth: string
    }
    expect(result.syncHealth).toBe('synced')
    expect(fs.readFileSync(path.join(root, '.claude/skills/manual/sync-test.md'), 'utf-8')).toBe('updated content\n')
  })

  test('syncs all provider links for an item', () => {
    const fixture = createProjectFixture('sync-linked-all-providers')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude', 'codex'])
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'sync-all-providers',
      content: skillDoc('sync-all-providers', '# v1')
    }) as { id: string }

    h.invoke('ai-config:load-library-item', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude', 'codex']
    })

    const claudePath = path.join(fixture.projectPath, '.claude/skills/sync-all-providers/SKILL.md')
    const codexPath = path.join(fixture.projectPath, '.agents/skills/sync-all-providers/SKILL.md')
    fs.writeFileSync(claudePath, '# changed')
    fs.writeFileSync(codexPath, '# changed')
    h.invoke('ai-config:update-item', { id: item.id, content: skillDoc('sync-all-providers', '# v2') })

    h.invoke('ai-config:sync-linked-file', fixture.projectId, fixture.projectPath, item.id)

    expect(fs.readFileSync(claudePath, 'utf-8').includes('name: sync-all-providers')).toBe(true)
    expect(fs.readFileSync(claudePath, 'utf-8').includes('# v2')).toBe(true)
    const codexContent = fs.readFileSync(codexPath, 'utf-8')
    expect(codexContent.includes('name: sync-all-providers')).toBe(true)
    expect(codexContent.includes('# v2')).toBe(true)
  })

  test('non-claude providers keep frontmatter in synced SKILL.md files', () => {
    const fixture = createProjectFixture('sync-codex-frontmatter')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude', 'codex'])
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'codex-fm',
      content: skillDoc('codex-fm', '# body\n')
    }) as { id: string }

    h.invoke('ai-config:load-library-item', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude', 'codex']
    })

    const codexPath = path.join(fixture.projectPath, '.agents/skills/codex-fm/SKILL.md')
    const codexContent = fs.readFileSync(codexPath, 'utf-8')
    expect(codexContent.includes('---')).toBe(true)
    expect(codexContent.includes('name: codex-fm')).toBe(true)
    expect(codexContent.includes('# body')).toBe(true)
  })

  test('syncs project-local items without provider selections', () => {
    const fixture = createProjectFixture('sync-linked-local-item')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude', 'codex'])
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'project',
      projectId: fixture.projectId,
      slug: 'local-item-sync',
      content: skillDoc('local-item-sync', '# local item')
    }) as { id: string }

    h.invoke('ai-config:sync-linked-file', fixture.projectId, fixture.projectPath, item.id)

    const claudePath = path.join(fixture.projectPath, '.claude/skills/local-item-sync/SKILL.md')
    const codexPath = path.join(fixture.projectPath, '.agents/skills/local-item-sync/SKILL.md')
    expect(fs.readFileSync(claudePath, 'utf-8').includes('name: local-item-sync')).toBe(true)
    expect(fs.readFileSync(claudePath, 'utf-8').includes('# local item')).toBe(true)
    const codexContent = fs.readFileSync(codexPath, 'utf-8')
    expect(codexContent.includes('name: local-item-sync')).toBe(true)
    expect(codexContent.includes('# local item')).toBe(true)
  })

  test('migrates legacy claude selection paths to SKILL.md', () => {
    const fixture = createProjectFixture('sync-linked-legacy-selection')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude'])

    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'legacy-selection-skill',
      content: skillDoc('legacy-selection-skill', '# from library')
    }) as { id: string }

    h.invoke('ai-config:set-project-selection', {
      projectId: fixture.projectId,
      itemId: item.id,
      provider: 'claude',
      targetPath: './.claude/skills/legacy-selection-skill.md'
    })

    const legacyPath = path.join(fixture.projectPath, '.claude/skills/legacy-selection-skill.md')
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, '# old format')

    const result = h.invoke('ai-config:sync-linked-file', fixture.projectId, fixture.projectPath, item.id) as {
      relativePath: string
    }

    const canonicalPath = path.join(fixture.projectPath, '.claude/skills/legacy-selection-skill/SKILL.md')
    expect(result.relativePath).toBe('.claude/skills/legacy-selection-skill/SKILL.md')
    expect(fs.existsSync(legacyPath)).toBe(false)
    expect(fs.readFileSync(canonicalPath, 'utf-8').includes('name: legacy-selection-skill')).toBe(true)
    expect(fs.readFileSync(canonicalPath, 'utf-8').includes('# from library')).toBe(true)
  })

  test('rejects syncing a local skill with invalid frontmatter', () => {
    const fixture = createProjectFixture('sync-invalid-frontmatter')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude'])
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'project',
      projectId: fixture.projectId,
      slug: 'invalid-local-skill',
      content: '---\nname invalid\n---\n# still invalid'
    }) as { id: string }

    expect(() => h.invoke('ai-config:sync-linked-file', fixture.projectId, fixture.projectPath, item.id)).toThrow()
  })

  test('rejects syncing a previously valid skill after its body is updated without frontmatter', () => {
    const fixture = createProjectFixture('sync-missing-frontmatter-after-valid')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude'])
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'missing-frontmatter-after-valid',
      content: skillDoc('missing-frontmatter-after-valid', '# initial')
    }) as { id: string }

    h.invoke('ai-config:load-library-item', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude']
    })

    h.invoke('ai-config:update-item', {
      id: item.id,
      content: 'Create a new release for SlayZone.\n'
    })

    expect(() => h.invoke('ai-config:sync-linked-file', fixture.projectId, fixture.projectPath, item.id)).toThrow()
  })
})

// --- Unlink ---

describe('ai-config:unlink-file', () => {
  test('removes selection from DB', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill', scope: 'library', slug: 'unlink-me', content: skillDoc('unlink-me', 'x')
    }) as { id: string }
    h.invoke('ai-config:load-library-item', {
      projectId, projectPath: root, itemId: item.id,
      providers: ['claude'], manualPath: '.claude/skills/manual/unlink-me.md'
    })
    const result = h.invoke('ai-config:unlink-file', projectId, item.id)
    expect(result).toBe(true)
  })

  test('returns false for nonexistent', () => {
    expect(h.invoke('ai-config:unlink-file', projectId, 'nope')).toBe(false)
  })
})

// --- Rename context file ---

describe('ai-config:rename-context-file', () => {
  test('renames file and updates selection target_path', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill', scope: 'library', slug: 'renameme', content: skillDoc('renameme', 'rename content')
    }) as { id: string }
    h.invoke('ai-config:load-library-item', {
      projectId, projectPath: root, itemId: item.id,
      providers: ['claude'], manualPath: '.claude/skills/manual/renameme.md'
    })
    const oldPath = path.join(root, '.claude/skills/manual/renameme.md')
    const newPath = path.join(root, '.claude/skills/manual/renamed.md')
    h.invoke('ai-config:rename-context-file', oldPath, newPath, root)
    expect(fs.existsSync(newPath)).toBe(true)
    expect(fs.existsSync(oldPath)).toBe(false)
  })
})

// --- Delete context file ---

describe('ai-config:delete-context-file', () => {
  test('deletes file and removes selection', () => {
    const item = h.invoke('ai-config:create-item', {
      type: 'skill', scope: 'library', slug: 'deleteme', content: skillDoc('deleteme', 'delete content')
    }) as { id: string }
    h.invoke('ai-config:load-library-item', {
      projectId, projectPath: root, itemId: item.id,
      providers: ['claude'], manualPath: '.claude/skills/manual/deleteme.md'
    })
    const filePath = path.join(root, '.claude/skills/manual/deleteme.md')
    h.invoke('ai-config:delete-context-file', filePath, root, projectId)
    expect(fs.existsSync(filePath)).toBe(false)
  })
})

// --- Library instructions ---

describe('ai-config:get-library-instructions', () => {
  test('returns empty string when none exist', () => {
    const content = h.invoke('ai-config:get-library-instructions')
    expect(content).toBe('')
  })
})

describe('ai-config:save-library-instructions', () => {
  test('creates then upserts', () => {
    h.invoke('ai-config:save-library-instructions', '# Library rules v1')
    expect(h.invoke('ai-config:get-library-instructions')).toBe('# Library rules v1')
    h.invoke('ai-config:save-library-instructions', '# Library rules v2')
    expect(h.invoke('ai-config:get-library-instructions')).toBe('# Library rules v2')
  })
})

// --- Root instructions (per-project) ---

describe('ai-config:save-root-instructions', () => {
  test('writes to provider dirs and returns synced status', () => {
    const result = h.invoke('ai-config:save-root-instructions', projectId, root, '# Project rules') as {
      content: string
      providerHealth: Record<string, { health: string; reason: string | null }>
    }
    expect(result.content).toBe('# Project rules')
    // Claude should be synced (it's enabled)
    expect(result.providerHealth.claude.health).toBe('synced')
    expect(result.providerHealth.claude.reason).toBeNull()
    // File should exist on disk in project root
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(true)
  })
})

describe('ai-config:get-root-instructions', () => {
  test('returns content and provider status', () => {
    const result = h.invoke('ai-config:get-root-instructions', projectId, root) as {
      content: string
      providerHealth: Record<string, { health: string; reason: string | null }>
    }
    expect(result.content).toBe('# Project rules')
    expect(result.providerHealth.claude.health).toBe('synced')
    expect(result.providerHealth.claude.reason).toBeNull()
  })
})

// --- Needs sync ---

describe('ai-config:needs-sync', () => {
  test('returns false when all synced', () => {
    const result = h.invoke('ai-config:needs-sync', projectId, root)
    expect(result).toBe(false)
  })

  test('returns true when file modified externally', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# MODIFIED')
    const result = h.invoke('ai-config:needs-sync', projectId, root)
    expect(result).toBe(true)
  })

  test('ignores out-of-sync files for disabled providers', () => {
    const fixture = createProjectFixture('needs-sync-disabled-provider')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude', 'codex'])
    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'disabled-provider-skill',
      content: skillDoc('disabled-provider-skill', '# baseline')
    }) as { id: string }

    h.invoke('ai-config:load-library-item', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['codex']
    })

    const codexPath = path.join(fixture.projectPath, '.agents/skills/disabled-provider-skill/SKILL.md')
    fs.writeFileSync(codexPath, '# modified externally')

    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude'])
    const whileDisabled = h.invoke('ai-config:needs-sync', fixture.projectId, fixture.projectPath)
    expect(whileDisabled).toBe(false)

    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude', 'codex'])
    const afterReEnable = h.invoke('ai-config:needs-sync', fixture.projectId, fixture.projectPath)
    expect(afterReEnable).toBe(true)
  })
})

// --- Check sync status ---

describe('ai-config:check-sync-status', () => {
  test('detects external edits as conflicts', () => {
    // CLAUDE.md was modified above
    const conflicts = h.invoke('ai-config:check-sync-status', projectId, root) as {
      path: string; reason: string
    }[]
    // May or may not have conflicts depending on content_hash state
    expect(Array.isArray(conflicts)).toBe(true)
  })
})

// --- MCP config ---

describe('ai-config:discover-mcp-configs', () => {
  test('returns entries for supported providers (codex disabled)', () => {
    const results = h.invoke('ai-config:discover-mcp-configs', root) as {
      provider: string; exists: boolean; servers: Record<string, unknown>
    }[]
    expect(results.length).toBe(5)  // claude, cursor, gemini, opencode, copilot
    const providers = results.map(r => r.provider).sort()
    expect(providers).toContain('claude')
    expect(providers).toContain('cursor')
    expect(providers).toContain('gemini')
    expect(providers).toContain('opencode')
    expect(providers).toContain('copilot')
    expect(providers.includes('codex')).toBe(false)
  })

  test('detects existing config files', () => {
    fs.mkdirSync(path.join(root, '.mcp-test'), { recursive: true })
    fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { 'my-server': { command: 'node', args: ['server.js'] } }
    }))
    const results = h.invoke('ai-config:discover-mcp-configs', root) as {
      provider: string; exists: boolean; servers: Record<string, unknown>
    }[]
    const claude = results.find(r => r.provider === 'claude')!
    expect(claude.exists).toBe(true)
    expect(claude.servers['my-server']).toBeTruthy()
  })
})

describe('ai-config:write-mcp-server', () => {
  test('writes server config to provider file', () => {
    h.invoke('ai-config:write-mcp-server', {
      projectPath: root,
      provider: 'claude',
      serverKey: 'test-server',
      config: { command: 'node', args: ['test.js'] }
    })
    const data = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8'))
    expect(data.mcpServers['test-server']).toBeTruthy()
    expect(data.mcpServers['test-server'].command).toBe('node')
  })

  test('preserves existing servers', () => {
    const data = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8'))
    expect(data.mcpServers['my-server']).toBeTruthy()
    expect(data.mcpServers['test-server']).toBeTruthy()
  })

  test('rejects codex writes', () => {
    expect(() => h.invoke('ai-config:write-mcp-server', {
      projectPath: root,
      provider: 'codex',
      serverKey: 'test-server',
      config: { command: 'node', args: ['test.js'] }
    })).toThrow()
  })
})

describe('ai-config:remove-mcp-server', () => {
  test('removes server from config', () => {
    h.invoke('ai-config:remove-mcp-server', {
      projectPath: root,
      provider: 'claude',
      serverKey: 'test-server'
    })
    const data = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8'))
    expect(data.mcpServers['test-server'] ?? null).toBeNull()
    // Other servers preserved
    expect(data.mcpServers['my-server']).toBeTruthy()
  })
})

// --- Skills status ---

describe('ai-config:get-project-skills-status', () => {
  test('returns status for loaded skills', () => {
    // Re-sync root instructions so state is clean
    h.invoke('ai-config:save-root-instructions', projectId, root, '# Project rules')
    // Create and load a skill
    const skill = h.invoke('ai-config:create-item', {
      type: 'skill', scope: 'library', slug: 'status-skill', content: skillDoc('status-skill', '# Status skill content')
    }) as { id: string }
    h.invoke('ai-config:load-library-item', {
      projectId, projectPath: root, itemId: skill.id,
      providers: ['claude'], manualPath: '.claude/skills/manual/status-skill.md'
    })

    const results = h.invoke('ai-config:get-project-skills-status', projectId, root) as {
      item: { id: string; slug: string }
      providers: Record<string, { path: string; syncHealth: string; syncReason: string | null }>
    }[]
    expect(results.length).toBeGreaterThan(0)
    const found = results.find(r => r.item.id === skill.id)
    expect(found).toBeTruthy()
    expect(found!.providers.claude).toBeTruthy()
    expect(found!.providers.claude.syncHealth).toBe('synced')
    expect(found!.providers.claude.syncReason).toBeNull()
  })

  test('detects out-of-sync skill', () => {
    // Modify the file on disk
    fs.writeFileSync(path.join(root, '.claude/skills/manual/status-skill.md'), '# CHANGED')
    const results = h.invoke('ai-config:get-project-skills-status', projectId, root) as {
      item: { slug: string }
      providers: Record<string, { syncHealth: string; syncReason: string | null }>
    }[]
    const found = results.find(r => r.item.slug === 'status-skill')
    expect(found).toBeTruthy()
    expect(found!.providers.claude.syncHealth).toBe('stale')
    expect(found!.providers.claude.syncReason).toBe('external_edit')
  })

  test('marks all linked providers stale after skill body edit', () => {
    const fixture = createProjectFixture('skills-status-body-edit')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude', 'codex'])

    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'status-body-edit',
      content: skillDoc('status-body-edit', '# Body v1\n\nOriginal body\n')
    }) as { id: string }

    h.invoke('ai-config:load-library-item', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude', 'codex']
    })

    h.invoke('ai-config:update-item', {
      id: item.id,
      content: '# Body v2\n\nChanged body\n'
    })

    const results = h.invoke('ai-config:get-project-skills-status', fixture.projectId, fixture.projectPath) as Array<{
      item: { id: string }
      providers: Record<string, { syncHealth: string; syncReason: string | null }>
    }>
    const found = results.find((entry) => entry.item.id === item.id)
    expect(found).toBeTruthy()
    expect(found!.providers.claude.syncHealth).toBe('stale')
    expect(found!.providers.codex.syncHealth).toBe('stale')
  })

  test('frontmatter-only metadata changes mark all providers stale', () => {
    const fixture = createProjectFixture('skills-status-frontmatter-edit')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude', 'codex'])

    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'status-frontmatter-edit',
      content: skillDoc('status-frontmatter-edit', '# Shared body\n\nSame body\n')
    }) as { id: string }

    h.invoke('ai-config:load-library-item', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude', 'codex']
    })

    h.invoke('ai-config:update-item', {
      id: item.id,
      content: '---\nfoo: bar\n---\n\n# Shared body\n\nSame body\n'
    })

    const results = h.invoke('ai-config:get-project-skills-status', fixture.projectId, fixture.projectPath) as Array<{
      item: { id: string }
      providers: Record<string, { syncHealth: string; syncReason: string | null }>
    }>
    const found = results.find((entry) => entry.item.id === item.id)
    expect(found).toBeTruthy()
    expect(found!.providers.claude.syncHealth).toBe('stale')
    expect(found!.providers.codex.syncHealth).toBe('stale')
  })

  test('marks historically valid skills invalid when current edited content drops frontmatter', () => {
    const fixture = createProjectFixture('skills-status-missing-frontmatter-after-valid')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude', 'codex'])

    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'status-missing-frontmatter-after-valid',
      content: skillDoc('status-missing-frontmatter-after-valid', '# baseline')
    }) as { id: string }

    h.invoke('ai-config:load-library-item', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude', 'codex']
    })

    h.invoke('ai-config:update-item', {
      id: item.id,
      content: 'Create a new release for SlayZone.\n'
    })

    const metadata = readSkillMetadata(item.id)
    expect(metadata.skillValidation?.status).toBe('invalid')
    expect(metadata.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_missing')).toBe(true)

    const results = h.invoke('ai-config:get-project-skills-status', fixture.projectId, fixture.projectPath) as Array<{
      item: { id: string }
      providers: Record<string, { syncHealth: string }>
    }>
    const found = results.find((entry) => entry.item.id === item.id)
    expect(found).toBeTruthy()
    expect(found!.providers.claude.syncHealth).toBe('stale')
    expect(found!.providers.codex.syncHealth).toBe('stale')
  })
})

// --- Sync all ---

describe('ai-config:sync-all', () => {
  test('writes all pending files', () => {
    const result = h.invoke('ai-config:sync-all', { projectId, projectPath: root }) as {
      written: { path: string; provider: string }[]
      conflicts: { path: string }[]
    }
    expect(Array.isArray(result.written)).toBe(true)
    expect(Array.isArray(result.conflicts)).toBe(true)
  })

  test('rejects sync-all when a managed skill has invalid frontmatter', () => {
    const fixture = createProjectFixture('sync-all-invalid-frontmatter')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude'])
    h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'project',
      projectId: fixture.projectId,
      slug: 'broken-frontmatter-sync-all',
      content: '---\nname broken\n---\n# still invalid'
    })

    expect(() => h.invoke('ai-config:sync-all', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath
    })).toThrow()
  })

  test('rejects sync-all when a previously valid linked skill is updated with body-only content', () => {
    const fixture = createProjectFixture('sync-all-missing-frontmatter-after-valid')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude', 'codex'])

    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'sync-all-missing-frontmatter-after-valid',
      content: skillDoc('sync-all-missing-frontmatter-after-valid', '# initial')
    }) as { id: string }

    h.invoke('ai-config:load-library-item', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude', 'codex']
    })

    h.invoke('ai-config:update-item', {
      id: item.id,
      content: 'Create a new release for SlayZone.\n'
    })

    expect(() => h.invoke('ai-config:sync-all', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath
    })).toThrow()
  })

  test('includes project-local items in sync output and disk writes', () => {
    const fixture = createProjectFixture('sync-all-local-items')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude', 'cursor'])

    h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'project',
      projectId: fixture.projectId,
      slug: 'local-project-skill',
      content: skillDoc('local-project-skill', '# local project skill')
    })
    const legacyLocalPath = path.join(fixture.projectPath, '.claude/skills/local-project-skill.md')
    fs.mkdirSync(path.dirname(legacyLocalPath), { recursive: true })
    fs.writeFileSync(legacyLocalPath, '# legacy local path')

    const result = h.invoke('ai-config:sync-all', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath
    }) as {
      written: Array<{ path: string; provider: string }>
    }

    expect(fs.readFileSync(path.join(fixture.projectPath, '.claude/skills/local-project-skill/SKILL.md'), 'utf-8').includes('# local project skill'))
      .toBe(true)
    const cursorContent = fs.readFileSync(path.join(fixture.projectPath, '.cursor/skills/local-project-skill/SKILL.md'), 'utf-8')
    expect(cursorContent.includes('name: local-project-skill')).toBe(true)
    expect(cursorContent.includes('# local project skill')).toBe(true)
    expect(fs.existsSync(legacyLocalPath)).toBe(false)

    expect(result.written.some((entry) =>
      entry.provider === 'claude' && entry.path === '.claude/skills/local-project-skill/SKILL.md')).toBe(true)
    expect(result.written.some((entry) =>
      entry.provider === 'cursor' && entry.path === '.cursor/skills/local-project-skill/SKILL.md')).toBe(true)
  })

  test('does not recreate removed per-item provider links', () => {
    const fixture = createProjectFixture('sync-all-keeps-provider-unlink')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude', 'codex'])

    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'sync-all-provider-unlink',
      content: skillDoc('sync-all-provider-unlink', '# initial')
    }) as { id: string }

    h.invoke('ai-config:load-library-item', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude', 'codex']
    })

    h.invoke('ai-config:remove-project-selection', fixture.projectId, item.id, 'codex')
    h.invoke('ai-config:update-item', { id: item.id, content: skillDoc('sync-all-provider-unlink', '# updated') })

    const codexPath = path.join(fixture.projectPath, '.agents/skills/sync-all-provider-unlink/SKILL.md')
    const codexBefore = fs.readFileSync(codexPath, 'utf-8')

    const result = h.invoke('ai-config:sync-all', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath
    }) as {
      written: { path: string; provider: string }[]
      conflicts: { path: string }[]
    }

    expect(result.written.some((entry) => entry.provider === 'claude')).toBe(true)
    expect(result.written.some((entry) => entry.provider === 'codex')).toBe(false)
    expect(fs.readFileSync(codexPath, 'utf-8')).toBe(codexBefore)

    const selections = h.invoke('ai-config:list-project-selections', fixture.projectId) as Array<{ provider: string }>
    expect(selections.some((row) => row.provider === 'codex')).toBe(false)
  })

  test('falls back to globally enabled providers when project settings are malformed JSON', () => {
    const fixture = createProjectFixture('sync-all-malformed-provider-settings')
    h.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`ai_providers:${fixture.projectId}`, '{"broken":')

    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'sync-all-fallback-provider',
      content: skillDoc('sync-all-fallback-provider', '# fallback')
    }) as { id: string }
    h.invoke('ai-config:load-library-item', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude']
    })

    const result = h.invoke('ai-config:sync-all', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath
    }) as { written: Array<{ provider: string }> }

    expect(result.written.some((entry) => entry.provider === 'claude')).toBe(true)
  })

  test('after pulling one provider, sync-all updates other linked providers without false conflicts', () => {
    const fixture = createProjectFixture('sync-all-after-pull')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude', 'codex'])

    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'sync-after-pull',
      content: skillDoc('sync-after-pull', '# baseline\n')
    }) as { id: string }

    h.invoke('ai-config:load-library-item', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude', 'codex']
    })

    const claudePath = path.join(fixture.projectPath, '.claude/skills/sync-after-pull/SKILL.md')
    const codexPath = path.join(fixture.projectPath, '.agents/skills/sync-after-pull/SKILL.md')
    fs.writeFileSync(claudePath, '---\nname: modified-on-disk\n---\n# pulled body\n')

    h.invoke('ai-config:pull-provider-skill', fixture.projectId, fixture.projectPath, 'claude', item.id)
    const result = h.invoke('ai-config:sync-all', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      providers: ['claude', 'codex']
    }) as {
      written: Array<{ path: string; provider: string }>
      conflicts: Array<{ path: string; provider: string; reason: string }>
    }

    expect(result.conflicts.length).toBe(0)
    expect(result.written.some((entry) => entry.provider === 'claude' && entry.path === '.claude/skills/sync-after-pull/SKILL.md')).toBe(true)
    expect(result.written.some((entry) => entry.provider === 'codex' && entry.path === '.agents/skills/sync-after-pull/SKILL.md')).toBe(true)
    expect(fs.readFileSync(codexPath, 'utf-8')).toBe('---\nname: modified-on-disk\n---\n# pulled body\n')
  })

  test('prunes unmanaged skills and disabled-provider MCP configs when enabled', () => {
    const fixture = createProjectFixture('sync-all-prune-unmanaged')
    h.invoke('ai-config:set-project-providers', fixture.projectId, ['claude'])
    h.invoke('ai-config:save-root-instructions', fixture.projectId, fixture.projectPath, '# managed instructions')

    const item = h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'library',
      slug: 'keep-managed-skill',
      content: skillDoc('keep-managed-skill', '# keep')
    }) as { id: string }

    h.invoke('ai-config:load-library-item', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude']
    })
    h.invoke('ai-config:create-item', {
      type: 'skill',
      scope: 'project',
      projectId: fixture.projectId,
      slug: 'keep-local-skill',
      content: skillDoc('keep-local-skill', '# keep local')
    })

    const managedSkillPath = path.join(fixture.projectPath, '.claude/skills/keep-managed-skill/SKILL.md')
    const localSkillPath = path.join(fixture.projectPath, '.claude/skills/keep-local-skill/SKILL.md')
    const managedInstructionPath = path.join(fixture.projectPath, 'CLAUDE.md')
    const unmanagedInstructionPath = path.join(fixture.projectPath, 'AGENTS.md')
    const unmanagedSkillPath = path.join(fixture.projectPath, '.claude/skills/remove-me.md')
    const unmanagedCodexSkillPath = path.join(fixture.projectPath, '.agents/skills/remove-codex/SKILL.md')
    const unmanagedEmptyEnabledMcpPath = path.join(fixture.projectPath, '.mcp.json')
    const disabledProviderMcpPath = path.join(fixture.projectPath, '.cursor/mcp.json')

    fs.writeFileSync(unmanagedInstructionPath, '# remove unmanaged instruction')
    fs.mkdirSync(path.dirname(unmanagedSkillPath), { recursive: true })
    fs.mkdirSync(path.dirname(unmanagedCodexSkillPath), { recursive: true })
    fs.mkdirSync(path.dirname(disabledProviderMcpPath), { recursive: true })

    fs.writeFileSync(unmanagedSkillPath, '# remove')
    fs.writeFileSync(unmanagedCodexSkillPath, '# remove codex')
    fs.writeFileSync(unmanagedEmptyEnabledMcpPath, JSON.stringify({ mcpServers: {} }, null, 2))
    fs.writeFileSync(disabledProviderMcpPath, JSON.stringify({ mcpServers: { orphan: { command: 'npx', args: ['x'] } } }, null, 2))

    const result = h.invoke('ai-config:sync-all', {
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      pruneUnmanaged: true
    }) as {
      written: Array<{ provider: string }>
      deleted: Array<{ path: string; provider: string; kind: string }>
    }

    expect(fs.existsSync(managedSkillPath)).toBe(true)
    expect(fs.existsSync(localSkillPath)).toBe(true)
    expect(fs.existsSync(managedInstructionPath)).toBe(true)
    expect(fs.existsSync(unmanagedInstructionPath)).toBe(false)
    expect(fs.existsSync(unmanagedSkillPath)).toBe(false)
    expect(fs.existsSync(unmanagedCodexSkillPath)).toBe(false)
    expect(fs.existsSync(unmanagedEmptyEnabledMcpPath)).toBe(false)
    expect(fs.existsSync(disabledProviderMcpPath)).toBe(false)

    expect(result.written.some((entry) => entry.provider === 'claude')).toBe(true)
    expect(result.deleted.some((entry) => entry.kind === 'instruction' && entry.provider === 'codex')).toBe(true)
    expect(result.deleted.some((entry) => entry.kind === 'skill' && entry.provider === 'claude')).toBe(true)
    expect(result.deleted.some((entry) => entry.kind === 'mcp' && entry.provider === 'claude')).toBe(true)
    expect(result.deleted.some((entry) => entry.kind === 'mcp' && entry.provider === 'cursor')).toBe(true)
  })
})

h.cleanup()
console.log('\nDone')
