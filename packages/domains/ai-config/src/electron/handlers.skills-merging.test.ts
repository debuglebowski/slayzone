/**
 * Comprehensive tests for ai-config:reconcile-project-skills handler
 * and the skillSlugFromContextPath shared utility.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 pnpm exec electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/ai-config/src/main/handlers.skills-merging.test.ts
 */
import { createTestHarness, test, expect, describe, type TestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { registerAiConfigHandlers } from './handlers.js'
import { skillSlugFromContextPath } from '../shared/skill-slug.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedProject(h: TestHarness, providers: string[] = ['claude', 'codex']) {
  const projectId = crypto.randomUUID()
  const projectPath = h.tmpDir()
  h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'TestProj', '#000', projectPath)
  h.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    `ai_providers:${projectId}`, JSON.stringify(providers)
  )
  return { projectId, projectPath }
}

function writeSkill(projectPath: string, provider: string, slug: string, content?: string) {
  const providerDirs: Record<string, string> = { claude: '.claude/skills', codex: '.agents/skills' }
  const dir = path.join(projectPath, providerDirs[provider] ?? `.${provider}/skills`, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    content ?? `---\nname: ${slug}\ndescription: ${slug} skill\n---\n${slug} body`
  )
}

function writeFlatSkill(projectPath: string, provider: string, slug: string, content?: string) {
  const providerDirs: Record<string, string> = { claude: '.claude/skills', codex: '.agents/skills' }
  const dir = path.join(projectPath, providerDirs[provider] ?? `.${provider}/skills`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${slug}.md`),
    content ?? `---\nname: ${slug}\ndescription: ${slug} skill\n---\n${slug} body`
  )
}

type AiConfigItem = { id: string; slug: string; name: string; scope: string; content: string; project_id: string | null }
type ProjectSkillStatus = { item: AiConfigItem; providers: Record<string, { syncHealth: string; syncReason: string | null }> }

// ---------------------------------------------------------------------------
// 1. skillSlugFromContextPath (pure function)
// ---------------------------------------------------------------------------

describe('skillSlugFromContextPath', () => {
  test('slug/SKILL.md → slug', () => {
    expect(skillSlugFromContextPath('.claude/skills/my-skill/SKILL.md')).toBe('my-skill')
  })
  test('flat .md → filename without extension', () => {
    expect(skillSlugFromContextPath('.claude/skills/my-skill.md')).toBe('my-skill')
  })
  test('bare SKILL.md → null (no parent dir)', () => {
    expect(skillSlugFromContextPath('SKILL.md')).toBeNull()
  })
  test('deeply nested SKILL.md → innermost dir', () => {
    expect(skillSlugFromContextPath('.claude/skills/deeply/nested/SKILL.md')).toBe('nested')
  })
  test('non-SKILL .md in subdirectory → filename', () => {
    expect(skillSlugFromContextPath('.claude/skills/my-skill/readme.md')).toBe('readme')
  })
  test('single-part .md file → filename', () => {
    expect(skillSlugFromContextPath('skill.md')).toBe('skill')
  })
  test('empty string → null', () => {
    expect(skillSlugFromContextPath('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. reconcile-project-skills: item creation
// ---------------------------------------------------------------------------

const h2 = await createTestHarness()
registerAiConfigHandlers(h2.ipcMain as never, h2.db)
const p2 = seedProject(h2)

describe('reconcile: item creation', () => {
  test('creates DB item with scope=project for disk-only skill', () => {
    writeSkill(p2.projectPath, 'claude', 'new-skill')
    const count = h2.invoke('ai-config:reconcile-project-skills', p2.projectId, p2.projectPath) as number
    expect(count).toBe(1)

    const items = h2.invoke('ai-config:list-items', { scope: 'project', projectId: p2.projectId, type: 'skill' }) as AiConfigItem[]
    const found = items.find(i => i.slug === 'new-skill')
    expect(found).toBeTruthy()
    expect(found!.scope).toBe('project')
  })

  test('created item content matches normalizeSkillForPersistence output', () => {
    const diskContent = '---\nname: content-check\ndescription: verify content\n---\nthe body'
    writeSkill(p2.projectPath, 'claude', 'content-check', diskContent)
    h2.invoke('ai-config:reconcile-project-skills', p2.projectId, p2.projectPath)

    const items = h2.invoke('ai-config:list-items', { scope: 'project', projectId: p2.projectId, type: 'skill' }) as AiConfigItem[]
    const found = items.find(i => i.slug === 'content-check')
    expect(found).toBeTruthy()
    // Content should contain the frontmatter and body (normalized)
    expect(found!.content.includes('content-check')).toBeTruthy()
    expect(found!.content.includes('the body')).toBeTruthy()
  })

  test('created item name equals normalized slug', () => {
    writeSkill(p2.projectPath, 'claude', 'name-test')
    h2.invoke('ai-config:reconcile-project-skills', p2.projectId, p2.projectPath)

    const items = h2.invoke('ai-config:list-items', { scope: 'project', projectId: p2.projectId, type: 'skill' }) as AiConfigItem[]
    const found = items.find(i => i.slug === 'name-test')
    expect(found!.name).toBe('name-test')
  })

  test('empty file creates item with empty-ish content', () => {
    writeSkill(p2.projectPath, 'claude', 'empty-file', '')
    h2.invoke('ai-config:reconcile-project-skills', p2.projectId, p2.projectPath)

    const items = h2.invoke('ai-config:list-items', { scope: 'project', projectId: p2.projectId, type: 'skill' }) as AiConfigItem[]
    const found = items.find(i => i.slug === 'empty-file')
    expect(found).toBeTruthy()
  })

  test('missing frontmatter → item created, name = slug', () => {
    writeSkill(p2.projectPath, 'claude', 'no-fm', 'Just plain text, no frontmatter')
    h2.invoke('ai-config:reconcile-project-skills', p2.projectId, p2.projectPath)

    const items = h2.invoke('ai-config:list-items', { scope: 'project', projectId: p2.projectId, type: 'skill' }) as AiConfigItem[]
    const found = items.find(i => i.slug === 'no-fm')
    expect(found).toBeTruthy()
    expect(found!.name).toBe('no-fm')
  })

  test('malformed YAML → item created, content preserved', () => {
    const badYaml = '---\nbad: [yaml without closing\n---\nthe body text'
    writeSkill(p2.projectPath, 'claude', 'bad-yaml', badYaml)
    h2.invoke('ai-config:reconcile-project-skills', p2.projectId, p2.projectPath)

    const items = h2.invoke('ai-config:list-items', { scope: 'project', projectId: p2.projectId, type: 'skill' }) as AiConfigItem[]
    const found = items.find(i => i.slug === 'bad-yaml')
    expect(found).toBeTruthy()
    expect(found!.content.includes('the body text')).toBeTruthy()
  })
})

h2.cleanup()

// ---------------------------------------------------------------------------
// 3. reconcile-project-skills: selections
// ---------------------------------------------------------------------------

const h3 = await createTestHarness()
registerAiConfigHandlers(h3.ipcMain as never, h3.db)
const p3 = seedProject(h3)

describe('reconcile: selections', () => {
  test('claude file gets selection with canonical target_path', () => {
    writeSkill(p3.projectPath, 'claude', 'sel-test')
    h3.invoke('ai-config:reconcile-project-skills', p3.projectId, p3.projectPath)

    const sels = h3.db.prepare(`
      SELECT ps.provider, ps.target_path FROM ai_config_project_selections ps
      JOIN ai_config_items i ON i.id = ps.item_id
      WHERE ps.project_id = ? AND i.slug = 'sel-test'
    `).all(p3.projectId) as Array<{ provider: string; target_path: string }>
    const claude = sels.find(s => s.provider === 'claude')
    expect(claude).toBeTruthy()
    expect(claude!.target_path).toBe('.claude/skills/sel-test/SKILL.md')
  })

  test('codex file gets selection with canonical .agents target_path', () => {
    writeSkill(p3.projectPath, 'codex', 'codex-sel')
    h3.invoke('ai-config:reconcile-project-skills', p3.projectId, p3.projectPath)

    const sels = h3.db.prepare(`
      SELECT ps.provider, ps.target_path FROM ai_config_project_selections ps
      JOIN ai_config_items i ON i.id = ps.item_id
      WHERE ps.project_id = ? AND i.slug = 'codex-sel'
    `).all(p3.projectId) as Array<{ provider: string; target_path: string }>
    const codex = sels.find(s => s.provider === 'codex')
    expect(codex).toBeTruthy()
    expect(codex!.target_path).toBe('.agents/skills/codex-sel/SKILL.md')
  })

  test('same slug in .claude + .agents → 1 item, 2 selections', () => {
    writeSkill(p3.projectPath, 'claude', 'dual')
    writeSkill(p3.projectPath, 'codex', 'dual')
    h3.invoke('ai-config:reconcile-project-skills', p3.projectId, p3.projectPath)

    const items = h3.db.prepare("SELECT * FROM ai_config_items WHERE slug = 'dual' AND scope = 'project'").all() as unknown[]
    expect(items).toHaveLength(1)

    const sels = h3.db.prepare(`
      SELECT ps.provider FROM ai_config_project_selections ps
      JOIN ai_config_items i ON i.id = ps.item_id
      WHERE ps.project_id = ? AND i.slug = 'dual'
    `).all(p3.projectId) as Array<{ provider: string }>
    expect(sels).toHaveLength(2)
    expect(sels.map(s => s.provider).sort()).toEqual(['claude', 'codex'])
  })

  test('selection target_path uses getSkillPath format', () => {
    writeSkill(p3.projectPath, 'claude', 'path-format')
    h3.invoke('ai-config:reconcile-project-skills', p3.projectId, p3.projectPath)

    const sels = h3.db.prepare(`
      SELECT ps.target_path FROM ai_config_project_selections ps
      JOIN ai_config_items i ON i.id = ps.item_id
      WHERE ps.project_id = ? AND i.slug = 'path-format' AND ps.provider = 'claude'
    `).all(p3.projectId) as Array<{ target_path: string }>
    // Canonical format: .claude/skills/{slug}/SKILL.md (not a raw relative path)
    expect(sels[0].target_path).toBe('.claude/skills/path-format/SKILL.md')
  })

  test('file only in .agents → single codex selection, no claude selection', () => {
    writeSkill(p3.projectPath, 'codex', 'codex-only')
    h3.invoke('ai-config:reconcile-project-skills', p3.projectId, p3.projectPath)

    const sels = h3.db.prepare(`
      SELECT ps.provider FROM ai_config_project_selections ps
      JOIN ai_config_items i ON i.id = ps.item_id
      WHERE ps.project_id = ? AND i.slug = 'codex-only'
    `).all(p3.projectId) as Array<{ provider: string }>
    expect(sels).toHaveLength(1)
    expect(sels[0].provider).toBe('codex')
  })
})

h3.cleanup()

// ---------------------------------------------------------------------------
// 4. reconcile-project-skills: dedup + idempotency
// ---------------------------------------------------------------------------

const h4 = await createTestHarness()
registerAiConfigHandlers(h4.ipcMain as never, h4.db)
const p4 = seedProject(h4)

describe('reconcile: dedup + idempotency', () => {
  test('second call with same files returns 0', () => {
    writeSkill(p4.projectPath, 'claude', 'idem-test')
    h4.invoke('ai-config:reconcile-project-skills', p4.projectId, p4.projectPath)

    const count = h4.invoke('ai-config:reconcile-project-skills', p4.projectId, p4.projectPath) as number
    expect(count).toBe(0)
  })

  test('pre-existing project item + selection → no duplication', () => {
    const item = h4.invoke('ai-config:create-item', {
      type: 'skill', scope: 'project', projectId: p4.projectId, slug: 'pre-existing',
      content: '---\nname: pre-existing\ndescription: d\n---\nb'
    }) as AiConfigItem
    h4.invoke('ai-config:set-project-selection', {
      projectId: p4.projectId, itemId: item.id, targetPath: '.claude/skills/pre-existing/SKILL.md'
    })
    writeSkill(p4.projectPath, 'claude', 'pre-existing')

    const count = h4.invoke('ai-config:reconcile-project-skills', p4.projectId, p4.projectPath) as number
    expect(count).toBe(0)
    const items = h4.db.prepare("SELECT * FROM ai_config_items WHERE slug = 'pre-existing'").all() as unknown[]
    expect(items).toHaveLength(1)
  })

  test('library item exists (no selection) + disk file → links library, count=0', () => {
    const libraryItem = h4.invoke('ai-config:create-item', {
      type: 'skill', scope: 'library', slug: 'library-link',
      content: '---\nname: library-link\ndescription: g\n---\nb'
    }) as AiConfigItem
    writeSkill(p4.projectPath, 'claude', 'library-link')

    const count = h4.invoke('ai-config:reconcile-project-skills', p4.projectId, p4.projectPath) as number
    expect(count).toBe(0) // no new ITEM created

    // But selection was created
    const sels = h4.db.prepare(
      'SELECT * FROM ai_config_project_selections WHERE project_id = ? AND item_id = ?'
    ).all(p4.projectId, libraryItem.id) as unknown[]
    expect(sels.length).toBeGreaterThan(0)
  })

  test('two projects share same library skill → both get selections', () => {
    const libraryItem = h4.invoke('ai-config:create-item', {
      type: 'skill', scope: 'library', slug: 'shared-library',
      content: '---\nname: shared-library\ndescription: s\n---\nb'
    }) as AiConfigItem

    const p4b = seedProject(h4)
    writeSkill(p4.projectPath, 'claude', 'shared-library')
    writeSkill(p4b.projectPath, 'claude', 'shared-library')

    h4.invoke('ai-config:reconcile-project-skills', p4.projectId, p4.projectPath)
    h4.invoke('ai-config:reconcile-project-skills', p4b.projectId, p4b.projectPath)

    // Both projects have selections, only 1 item
    const items = h4.db.prepare("SELECT * FROM ai_config_items WHERE slug = 'shared-library'").all() as unknown[]
    expect(items).toHaveLength(1)

    const selsA = h4.db.prepare('SELECT * FROM ai_config_project_selections WHERE project_id = ? AND item_id = ?').all(p4.projectId, libraryItem.id) as unknown[]
    const selsB = h4.db.prepare('SELECT * FROM ai_config_project_selections WHERE project_id = ? AND item_id = ?').all(p4b.projectId, libraryItem.id) as unknown[]
    expect(selsA.length).toBeGreaterThan(0)
    expect(selsB.length).toBeGreaterThan(0)
  })

  test('item for different project (scope=project, other project_id) → creates new item', () => {
    const other = seedProject(h4)
    h4.invoke('ai-config:create-item', {
      type: 'skill', scope: 'project', projectId: other.projectId, slug: 'other-proj-skill',
      content: '---\nname: other-proj-skill\ndescription: d\n---\nb'
    })
    writeSkill(p4.projectPath, 'claude', 'other-proj-skill')

    const count = h4.invoke('ai-config:reconcile-project-skills', p4.projectId, p4.projectPath) as number
    expect(count).toBe(1) // creates NEW item for this project

    const items = h4.db.prepare("SELECT * FROM ai_config_items WHERE slug = 'other-proj-skill'").all() as unknown[]
    expect(items).toHaveLength(2) // one per project
  })
})

h4.cleanup()

// ---------------------------------------------------------------------------
// 5. reconcile-project-skills: slug normalization
// ---------------------------------------------------------------------------

const h5 = await createTestHarness()
registerAiConfigHandlers(h5.ipcMain as never, h5.db)
const p5 = seedProject(h5)

describe('reconcile: slug normalization', () => {
  test('uppercase dir name normalized to lowercase', () => {
    writeSkill(p5.projectPath, 'claude', 'My-Skill')
    h5.invoke('ai-config:reconcile-project-skills', p5.projectId, p5.projectPath)

    const items = h5.invoke('ai-config:list-items', { scope: 'project', projectId: p5.projectId, type: 'skill' }) as AiConfigItem[]
    const found = items.find(i => i.slug === 'my-skill')
    expect(found).toBeTruthy()
  })

  test('special chars in dir replaced with hyphens', () => {
    writeSkill(p5.projectPath, 'claude', 'my!!!skill')
    h5.invoke('ai-config:reconcile-project-skills', p5.projectId, p5.projectPath)

    const items = h5.invoke('ai-config:list-items', { scope: 'project', projectId: p5.projectId, type: 'skill' }) as AiConfigItem[]
    const found = items.find(i => i.slug === 'my-skill')
    expect(found).toBeTruthy()
  })

  test('only special chars normalizes to untitled', () => {
    writeSkill(p5.projectPath, 'claude', '___')
    h5.invoke('ai-config:reconcile-project-skills', p5.projectId, p5.projectPath)

    const items = h5.invoke('ai-config:list-items', { scope: 'project', projectId: p5.projectId, type: 'skill' }) as AiConfigItem[]
    const found = items.find(i => i.slug === 'untitled')
    expect(found).toBeTruthy()
  })

  test('mixed case + underscores normalized', () => {
    writeSkill(p5.projectPath, 'claude', 'My_Cool_Skill')
    h5.invoke('ai-config:reconcile-project-skills', p5.projectId, p5.projectPath)

    const items = h5.invoke('ai-config:list-items', { scope: 'project', projectId: p5.projectId, type: 'skill' }) as AiConfigItem[]
    const found = items.find(i => i.slug === 'my-cool-skill')
    expect(found).toBeTruthy()
  })
})

h5.cleanup()

// ---------------------------------------------------------------------------
// 6. reconcile-project-skills: edge cases
// ---------------------------------------------------------------------------

const h6 = await createTestHarness()
registerAiConfigHandlers(h6.ipcMain as never, h6.db)
const p6 = seedProject(h6)

describe('reconcile: edge cases', () => {
  test('no skill directories on disk → returns 0', () => {
    const count = h6.invoke('ai-config:reconcile-project-skills', p6.projectId, p6.projectPath) as number
    expect(count).toBe(0)
  })

  test('empty skills dir (exists but no files) → returns 0', () => {
    fs.mkdirSync(path.join(p6.projectPath, '.claude', 'skills'), { recursive: true })
    const count = h6.invoke('ai-config:reconcile-project-skills', p6.projectId, p6.projectPath) as number
    expect(count).toBe(0)
  })

  test('non-.md files in skill directory are ignored', () => {
    const dir = path.join(p6.projectPath, '.claude', 'skills', 'has-txt')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.txt'), 'not markdown')
    fs.writeFileSync(path.join(dir, 'notes.json'), '{}')

    const count = h6.invoke('ai-config:reconcile-project-skills', p6.projectId, p6.projectPath) as number
    expect(count).toBe(0)
  })

  test('flat .md file creates item correctly', () => {
    writeFlatSkill(p6.projectPath, 'claude', 'flat-skill')
    const count = h6.invoke('ai-config:reconcile-project-skills', p6.projectId, p6.projectPath) as number
    expect(count).toBe(1)

    const items = h6.invoke('ai-config:list-items', { scope: 'project', projectId: p6.projectId, type: 'skill' }) as AiConfigItem[]
    const found = items.find(i => i.slug === 'flat-skill')
    expect(found).toBeTruthy()
  })

  test('backward compat agents/ dir (no dot) is NOT scanned', () => {
    const dir = path.join(p6.projectPath, 'agents', 'not-scanned')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: not-scanned\ndescription: d\n---\nb')

    const count = h6.invoke('ai-config:reconcile-project-skills', p6.projectId, p6.projectPath) as number
    // Should not pick up this file (only PROVIDER_PATHS dirs are scanned)
    const items = h6.invoke('ai-config:list-items', { scope: 'project', projectId: p6.projectId, type: 'skill' }) as AiConfigItem[]
    const found = items.find(i => i.slug === 'not-scanned')
    expect(found).toBeUndefined()
  })
})

h6.cleanup()

// ---------------------------------------------------------------------------
// 7. file deleted / edited after reconcile
// ---------------------------------------------------------------------------

const h7 = await createTestHarness()
registerAiConfigHandlers(h7.ipcMain as never, h7.db)
const p7 = seedProject(h7)

describe('reconcile: file lifecycle (delete / edit)', () => {
  test('file deleted → getProjectSkillsStatus reports stale/missing_file', () => {
    const content = '---\nname: will-delete\ndescription: d\n---\nbody'
    writeSkill(p7.projectPath, 'claude', 'will-delete', content)
    h7.invoke('ai-config:reconcile-project-skills', p7.projectId, p7.projectPath)

    // Delete the file
    const filePath = path.join(p7.projectPath, '.claude', 'skills', 'will-delete', 'SKILL.md')
    fs.unlinkSync(filePath)

    const statuses = h7.invoke('ai-config:get-project-skills-status', p7.projectId, p7.projectPath) as ProjectSkillStatus[]
    const found = statuses.find(s => s.item.slug === 'will-delete')
    expect(found).toBeTruthy()
    const claudeStatus = found!.providers['claude' as keyof typeof found.providers] as { syncHealth: string; syncReason: string | null } | undefined
    expect(claudeStatus).toBeTruthy()
    expect(claudeStatus!.syncHealth).toBe('stale')
    expect(claudeStatus!.syncReason).toBe('missing_file')
  })

  test('file deleted → re-reconcile does NOT create duplicate item', () => {
    // will-delete item already exists from previous test, file is gone
    const count = h7.invoke('ai-config:reconcile-project-skills', p7.projectId, p7.projectPath) as number
    expect(count).toBe(0)

    const items = h7.db.prepare("SELECT * FROM ai_config_items WHERE slug = 'will-delete'").all() as unknown[]
    expect(items).toHaveLength(1)
  })

  test('file externally edited → getProjectSkillsStatus reports stale/external_edit', () => {
    const original = '---\nname: will-edit\ndescription: d\n---\noriginal body'
    writeSkill(p7.projectPath, 'claude', 'will-edit', original)
    h7.invoke('ai-config:reconcile-project-skills', p7.projectId, p7.projectPath)

    // Sync the file first so expected content matches
    h7.invoke('ai-config:sync-linked-file', p7.projectId, p7.projectPath,
      (h7.db.prepare("SELECT id FROM ai_config_items WHERE slug = 'will-edit'").get() as { id: string }).id,
      'claude'
    )

    // Now externally edit the file
    const filePath = path.join(p7.projectPath, '.claude', 'skills', 'will-edit', 'SKILL.md')
    fs.writeFileSync(filePath, '---\nname: will-edit\ndescription: d\n---\nmodified body')

    const statuses = h7.invoke('ai-config:get-project-skills-status', p7.projectId, p7.projectPath) as ProjectSkillStatus[]
    const found = statuses.find(s => s.item.slug === 'will-edit')
    expect(found).toBeTruthy()
    const claudeStatus = found!.providers['claude' as keyof typeof found.providers] as { syncHealth: string; syncReason: string | null } | undefined
    expect(claudeStatus).toBeTruthy()
    expect(claudeStatus!.syncHealth).toBe('stale')
    expect(claudeStatus!.syncReason).toBe('external_edit')
  })
})

h7.cleanup()

// ---------------------------------------------------------------------------
// 8. SkillsSection contract (source-reading tests)
// ---------------------------------------------------------------------------

describe('SkillsSection contract', () => {
  test('calls reconcileProjectSkills before loading items', () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, '../client/SkillsSection.tsx'), 'utf-8'
    )
    expect(source.includes('reconcileProjectSkills')).toBeTruthy()

    // Verify reconcile is called BEFORE listItems
    const reconcileIdx = source.indexOf('reconcileProjectSkills')
    const listItemsIdx = source.indexOf('listItems')
    expect(reconcileIdx).toBeGreaterThan(-1)
    expect(listItemsIdx).toBeGreaterThan(-1)
    expect(reconcileIdx < listItemsIdx).toBeTruthy()
  })

  test('does NOT import computeUnmanagedSkillRows or unmanaged-skills', () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, '../client/SkillsSection.tsx'), 'utf-8'
    )
    expect(source.includes('computeUnmanagedSkillRows')).toBeFalsy()
    expect(source.includes('unmanaged-skills')).toBeFalsy()
  })
})

console.log('\nDone')
