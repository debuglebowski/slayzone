/**
 * ai-config router contract tests — exercise the procedures via tRPC
 * `createCaller` against the in-memory harness DB (async SlayzoneDb) with the
 * real injected ops singletons. Ported from the six ai-config IPC-handler
 * contract suites (handlers.items / handlers.selections / handlers.context /
 * handlers.skills-status / handlers.skills-merging / handlers-marketplace-sync)
 * — coverage now lives here as the renderer cuts over to tRPC.
 *
 * Run with electron + experimental-loader (see test-utils/run-all.sh):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/shared/transport/src/server/routers/ai-config.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../test-utils/ipc-harness.js'
import { initAiConfigOps } from '@slayzone/ai-config/server'
import { skillSlugFromContextPath } from '@slayzone/ai-config/shared'
import { aiConfigRouter } from './ai-config.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// The harness `expect` only ships a sync `toThrow()`. Router mutations/queries
// are async (the ops resolve Promises), so rejections need a manual await-guard.
const didThrow = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

// ===========================================================================
// 0. skillSlugFromContextPath — pure shared util (was handlers.skills-merging)
// ===========================================================================

await describe('skillSlugFromContextPath', () => {
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

// ===========================================================================
// shared harness + caller wiring
// ===========================================================================
// Procs delegate to the module-singleton ops (getAiConfigOps/getMarketplaceOps),
// which throw if uninitialized. initAiConfigOps(h.slayDb) wires both singletons
// to the harness's async DB proxy (what registerAiConfigHandlers did internally
// in the IPC tests). createCaller needs a ctx but the procs ignore it.
const h = await createTestHarness()
initAiConfigOps(h.slayDb)
// Marketplace builtin entries are seeded fire-and-forget at ops construction;
// await it explicitly so the marketplace suites can read skill_registry_entries
// synchronously. Idempotent (no-ops if already seeded).
await h.slayDb.namedTxn('ai-config:marketplace:seed-builtin-entries', {})
const caller = aiConfigRouter.createCaller({ db: h.slayDb } as never)

const skillDoc = (slug: string, body: string): string => {
  const normalizedBody = body.endsWith('\n') ? body : `${body}\n`
  return `---\nname: ${slug}\ndescription: ${slug}\n---\n${normalizedBody}`
}

const readSkillMetadata = (
  itemId: string
): { skillValidation?: { status?: string; issues?: Array<{ code?: string }> } } => {
  const row = h.db.prepare('SELECT metadata_json FROM ai_config_items WHERE id = ?').get(itemId) as {
    metadata_json: string
  }
  return JSON.parse(row.metadata_json)
}

// ===========================================================================
// 1. Items (was handlers.items)
// ===========================================================================

const itemsProjectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)')
  .run(itemsProjectId, 'P', '#000')

let libraryItemId: string
let projectItemId: string

await describe('createItem', () => {
  test('creates library item', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'My Skill!',
      content: '# Skill content'
    })) as {
      id: string
      type: string
      scope: string
      slug: string
      name: string
      content: string
      project_id: null
    }
    expect(item.type).toBe('skill')
    expect(item.scope).toBe('library')
    expect(item.slug).toBe('my-skill')
    expect(item.name).toBe('my-skill')
    expect(item.content).toBe('# Skill content')
    expect(item.project_id).toBeNull()
    libraryItemId = item.id
  })

  test('creates project-scoped item', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'project',
      projectId: itemsProjectId,
      slug: 'deploy',
      content: 'run deploy'
    })) as { id: string; project_id: string; scope: string }
    expect(item.scope).toBe('project')
    expect(item.project_id).toBe(itemsProjectId)
    projectItemId = item.id
  })

  test('normalizes slug', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: '  --Hello World!! --',
      content: ''
    })) as { slug: string }
    expect(item.slug).toBe('hello-world')
  })

  test('empty slug becomes untitled', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: '!!!',
      content: ''
    })) as { slug: string }
    expect(item.slug).toBe('untitled')
  })

  test('rejects duplicate library slug for same type', async () => {
    expect(
      await didThrow(() =>
        caller.createItem({ type: 'skill', scope: 'library', slug: 'my-skill', content: '' })
      )
    ).toBe(true)
  })

  test('rejects duplicate project slug for same project and type', async () => {
    expect(
      await didThrow(() =>
        caller.createItem({
          type: 'skill',
          scope: 'project',
          projectId: itemsProjectId,
          slug: 'deploy',
          content: ''
        })
      )
    ).toBe(true)
  })
})

await describe('getItem', () => {
  test('returns item by id', async () => {
    const item = (await caller.getItem({ id: libraryItemId })) as { id: string }
    expect(item.id).toBe(libraryItemId)
  })

  test('returns null for nonexistent', async () => {
    expect(await caller.getItem({ id: 'nope' })).toBeNull()
  })
})

await describe('listItems', () => {
  test('filters by scope', async () => {
    const items = (await caller.listItems({ scope: 'library' })) as { scope: string }[]
    for (const item of items) expect(item.scope).toBe('library')
  })

  test('filters by scope + type', async () => {
    const items = (await caller.listItems({ scope: 'library', type: 'skill' })) as { type: string }[]
    for (const item of items) expect(item.type).toBe('skill')
    expect(items.length).toBeGreaterThan(0)
  })

  test('filters by scope + project', async () => {
    const items = (await caller.listItems({ scope: 'project', projectId: itemsProjectId })) as {
      project_id: string
    }[]
    expect(items).toHaveLength(1)
    expect(items[0].project_id).toBe(itemsProjectId)
  })
})

await describe('updateItem', () => {
  test('updates content', async () => {
    const item = (await caller.updateItem({
      id: libraryItemId,
      content: 'updated content'
    })) as { content: string }
    expect(item.content).toBe('updated content')
  })

  test('updates slug (normalized)', async () => {
    const item = (await caller.updateItem({ id: libraryItemId, slug: 'New Name!!' })) as {
      slug: string
      name: string
    }
    expect(item.slug).toBe('new-name')
    expect(item.name).toBe('new-name')
  })

  test('updates scope to library clears project_id', async () => {
    const item = (await caller.updateItem({ id: projectItemId, scope: 'library' })) as {
      scope: string
      project_id: null
    }
    expect(item.scope).toBe('library')
    expect(item.project_id).toBeNull()
  })

  test('returns null for nonexistent', async () => {
    expect(await caller.updateItem({ id: 'nope', content: 'x' })).toBeNull()
  })

  test('rejects update when slug collides in same scope/type', async () => {
    const other = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'another-skill',
      content: ''
    })) as { id: string }
    expect(await didThrow(() => caller.updateItem({ id: other.id, slug: 'new-name' }))).toBe(true)
  })
})

await describe('deleteItem', () => {
  test('deletes existing', async () => {
    expect(await caller.deleteItem({ id: libraryItemId })).toBe(true)
    expect(await caller.getItem({ id: libraryItemId })).toBeNull()
  })

  test('returns false for nonexistent', async () => {
    expect(await caller.deleteItem({ id: 'nope' })).toBe(false)
  })
})

// ===========================================================================
// 2. Selections + providers (was handlers.selections)
// ===========================================================================

const selProjectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(selProjectId, 'PSel', '#000', '/tmp/test-proj')
const selItem = (await caller.createItem({
  type: 'skill',
  scope: 'library',
  slug: 'sel-test',
  content: 'x'
})) as { id: string }
const selItem2 = (await caller.createItem({
  type: 'skill',
  scope: 'library',
  slug: 'sel-test-2',
  content: 'y'
})) as { id: string }

await describe('setProjectSelection', () => {
  test('creates selection and canonicalizes legacy claude skill paths', async () => {
    await caller.setProjectSelection({
      projectId: selProjectId,
      itemId: selItem.id,
      targetPath: '.claude/skills/sel-test.md'
    })
    const sels = (await caller.listProjectSelections({ projectId: selProjectId })) as {
      item_id: string
      target_path: string
      provider: string
    }[]
    expect(sels).toHaveLength(1)
    expect(sels[0].item_id).toBe(selItem.id)
    expect(sels[0].target_path).toBe('.claude/skills/sel-test/SKILL.md')
    expect(sels[0].provider).toBe('claude')
  })

  test('upserts on conflict (same project+item+provider)', async () => {
    await caller.setProjectSelection({
      projectId: selProjectId,
      itemId: selItem.id,
      targetPath: '.claude/skills/updated.md'
    })
    const sels = (await caller.listProjectSelections({ projectId: selProjectId })) as {
      target_path: string
    }[]
    expect(sels.filter((s) => s.target_path === '.claude/skills/updated.md')).toHaveLength(1)
  })

  test('allows multiple items per project', async () => {
    await caller.setProjectSelection({
      projectId: selProjectId,
      itemId: selItem2.id,
      targetPath: '.claude/skills/test.md'
    })
    const sels = (await caller.listProjectSelections({ projectId: selProjectId })) as unknown[]
    expect(sels.length).toBeGreaterThan(1)
  })

  test('supports provider-specific upserts', async () => {
    await caller.setProjectSelection({
      projectId: selProjectId,
      itemId: selItem.id,
      provider: 'codex',
      targetPath: '.agents/skills/sel-test.md'
    })
    const sels = (await caller.listProjectSelections({ projectId: selProjectId })) as Array<{
      provider: string
      target_path: string
    }>
    const codexSel = sels.find((sel) => sel.provider === 'codex')
    expect(codexSel).toBeTruthy()
    expect(codexSel!.target_path).toBe('.agents/skills/sel-test/SKILL.md')
  })
})

await describe('listProjectSelections', () => {
  test('returns empty for unknown project', async () => {
    const sels = (await caller.listProjectSelections({ projectId: 'nonexistent' })) as unknown[]
    expect(sels).toHaveLength(0)
  })
})

await describe('removeProjectSelection', () => {
  test('removes by project+item (all providers)', async () => {
    const result = await caller.removeProjectSelection({
      projectId: selProjectId,
      itemId: selItem2.id
    })
    expect(result).toBe(true)
  })

  test('returns false for nonexistent', async () => {
    const result = await caller.removeProjectSelection({ projectId: selProjectId, itemId: 'nope' })
    expect(result).toBe(false)
  })

  test('removes by project+item+provider', async () => {
    const result = await caller.removeProjectSelection({
      projectId: selProjectId,
      itemId: selItem.id,
      provider: 'claude'
    })
    expect(result).toBe(true)
    const sels = (await caller.listProjectSelections({ projectId: selProjectId })) as Array<{
      provider: string
    }>
    expect(sels).toHaveLength(1)
    expect(sels[0].provider).toBe('codex')
  })
})

await describe('listProviders', () => {
  test('returns seeded providers', async () => {
    const providers = (await caller.listProviders()) as {
      name: string
      kind: string
      enabled: number
    }[]
    expect(providers.length).toBeGreaterThan(0)
    const claude = providers.find((p) => p.kind === 'claude')
    const codex = providers.find((p) => p.kind === 'codex')
    expect(claude).toBeTruthy()
    expect(codex).toBeTruthy()
    expect(claude!.enabled).toBe(1)
  })
})

await describe('toggleProvider', () => {
  // Handler test toggled provider-claude, but the current op refuses to disable
  // the default terminal-mode provider (claude). Exercise the enable/disable
  // round-trip on a non-default provider (cursor) instead — same contract — and
  // assert the default-guard separately.
  test('enables provider', async () => {
    await caller.toggleProvider({ id: 'provider-cursor', enabled: true })
    const providers = (await caller.listProviders()) as { kind: string; enabled: number }[]
    const cursor = providers.find((p) => p.kind === 'cursor')
    expect(cursor!.enabled).toBe(1)
  })

  test('disables provider', async () => {
    await caller.toggleProvider({ id: 'provider-cursor', enabled: false })
    const providers = (await caller.listProviders()) as { kind: string; enabled: number }[]
    const cursor = providers.find((p) => p.kind === 'cursor')
    expect(cursor!.enabled).toBe(0)
  })

  test('refuses to disable the default-mode provider (claude)', async () => {
    await caller.toggleProvider({ id: 'provider-claude', enabled: false })
    const providers = (await caller.listProviders()) as { kind: string; enabled: number }[]
    const claude = providers.find((p) => p.kind === 'claude')
    expect(claude!.enabled).toBe(1)
  })
})

await describe('getProjectProviders', () => {
  test('returns default providers (falls back to computer)', async () => {
    const providers = (await caller.getProjectProviders({ projectId: selProjectId })) as string[]
    expect(providers).toContain('claude')
  })

  test('falls back to computer providers when project provider settings JSON is malformed', async () => {
    h.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(`ai_providers:${selProjectId}`, '{"broken":')
    const providers = (await caller.getProjectProviders({ projectId: selProjectId })) as string[]
    expect(providers).toContain('claude')
  })
})

await describe('setProjectProviders', () => {
  test('persists configured project providers', async () => {
    await caller.setProjectProviders({ projectId: selProjectId, providers: ['claude', 'codex'] })
    const providers = (await caller.getProjectProviders({ projectId: selProjectId })) as string[]
    expect(providers).toContain('claude')
    expect(providers).toContain('codex')
  })
})

// ===========================================================================
// 3. Context files / sync / instructions / MCP (was handlers.context)
// ===========================================================================

const root = h.tmpDir()
const ctxProjectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(ctxProjectId, 'Ctx', '#000', root)

const createProjectFixture = (name: string): { projectId: string; projectPath: string } => {
  const id = crypto.randomUUID()
  const projectPath = path.join(root, name)
  fs.mkdirSync(projectPath, { recursive: true })
  h.db
    .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
    .run(id, name, '#000', projectPath)
  return { projectId: id, projectPath }
}

// Ensure claude is enabled (router toggles above flipped it back on, but be safe)
h.db.prepare("UPDATE ai_config_sources SET enabled = 1 WHERE kind = 'claude'")?.run()

await describe('discoverContextFiles', () => {
  test('finds CLAUDE.md when present', async () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# rules')
    const entries = (await caller.discoverContextFiles({ projectPath: root })) as {
      name: string
      exists: boolean
    }[]
    const claudeMd = entries.find((e) => e.name === 'CLAUDE.md')
    expect(claudeMd).toBeTruthy()
    expect(claudeMd!.exists).toBe(true)
  })
})

await describe('getContextTree', () => {
  test('marks disk-only skill files as unmanaged', async () => {
    const fixture = createProjectFixture('context-tree-unmanaged-skill')
    const diskOnlyPath = path.join(fixture.projectPath, '.agents/skills/disk-only-skill/SKILL.md')
    fs.mkdirSync(path.dirname(diskOnlyPath), { recursive: true })
    fs.writeFileSync(diskOnlyPath, '# disk only')

    const entries = (await caller.getContextTree({
      projectPath: fixture.projectPath,
      projectId: fixture.projectId
    })) as Array<{
      relativePath: string
      linkedItemId: string | null
      syncHealth: string
      syncReason: string | null
    }>
    const found = entries.find((e) => e.relativePath === '.agents/skills/disk-only-skill/SKILL.md')
    expect(found).toBeTruthy()
    expect(found!.linkedItemId).toBeNull()
    expect(found!.syncHealth).toBe('unmanaged')
    expect(found!.syncReason).toBe('not_linked')
  })

  test('discovers unmanaged skill files for non-claude/codex providers', async () => {
    const fixture = createProjectFixture('context-tree-unmanaged-cursor-skill')
    const diskOnlyPath = path.join(
      fixture.projectPath,
      '.cursor/skills/disk-only-cursor-skill/SKILL.md'
    )
    fs.mkdirSync(path.dirname(diskOnlyPath), { recursive: true })
    fs.writeFileSync(diskOnlyPath, '# cursor disk only')

    const entries = (await caller.getContextTree({
      projectPath: fixture.projectPath,
      projectId: fixture.projectId
    })) as Array<{
      relativePath: string
      provider?: string
      linkedItemId: string | null
      syncHealth: string
      syncReason: string | null
    }>
    const found = entries.find(
      (e) => e.relativePath === '.cursor/skills/disk-only-cursor-skill/SKILL.md'
    )
    expect(found).toBeTruthy()
    expect(found!.provider).toBe('cursor')
    expect(found!.linkedItemId).toBeNull()
    expect(found!.syncHealth).toBe('unmanaged')
    expect(found!.syncReason).toBe('not_linked')
  })
})

await describe('readContextFile', () => {
  test('reads file content', async () => {
    const content = await caller.readContextFile({
      filePath: path.join(root, 'CLAUDE.md'),
      projectPath: root
    })
    expect(content).toBe('# rules')
  })

  test('rejects path outside project', async () => {
    expect(
      await didThrow(() => caller.readContextFile({ filePath: '/etc/passwd', projectPath: root }))
    ).toBe(true)
  })
})

await describe('writeContextFile', () => {
  test('writes file', async () => {
    await caller.writeContextFile({
      filePath: path.join(root, 'CLAUDE.md'),
      content: '# updated',
      projectPath: root
    })
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8')).toBe('# updated')
  })
})

await describe('createComputerFile', () => {
  // Handler test hardcoded /tmp/mock-home (assumes HOME=/tmp/mock-home) and
  // passed provider 'gemini', but asserted the `.agents/skills` path. In the
  // current provider registry gemini has NO skillsDir (the op throws "does not
  // support skills"); the `.agents/skills` path belongs to the `agents` provider.
  // Port against `agents` (the provider that actually owns that path) and derive
  // the home dir from os.homedir() since the loader doesn't stub HOME.
  test('creates a normalized computer skill file', async () => {
    const expectedPath = path.join(os.homedir(), '.agents', 'skills', 'my-computer-skill.md')
    if (fs.existsSync(expectedPath)) fs.unlinkSync(expectedPath)

    const created = (await caller.createComputerFile({
      provider: 'agents',
      category: 'skill',
      slug: ' My Computer Skill! '
    })) as { path: string; provider: string; category: string; exists: boolean }

    expect(created.path).toBe(expectedPath)
    expect(created.provider).toBe('agents')
    expect(created.category).toBe('skill')
    expect(created.exists).toBe(true)
    expect(fs.existsSync(expectedPath)).toBe(true)
    // Cleanup so reruns don't trip the "File already exists" guard.
    fs.unlinkSync(expectedPath)
  })

  test('rejects unsupported categories for provider', async () => {
    expect(
      await didThrow(() =>
        caller.createComputerFile({ provider: 'codex', category: 'skill', slug: 'nope' })
      )
    ).toBe(true)
  })
})

await describe('listItems: runtime skill-validation derivation', () => {
  test('returns derived validation without mutating stored metadata on read', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'read-does-not-repair-db',
      content: '# body'
    })) as { id: string; metadata_json: string }

    const staleMeta = JSON.parse(item.metadata_json) as Record<string, unknown>
    staleMeta.skillValidation = {
      status: 'invalid',
      issues: [{ code: 'frontmatter_invalid_line', severity: 'error', message: 'stale issue', line: 4 }]
    }
    const staleMetadataJson = JSON.stringify(staleMeta)
    h.db
      .prepare('UPDATE ai_config_items SET content = ?, metadata_json = ? WHERE id = ?')
      .run(
        '---\nname: read-does-not-repair-db\ndescription: "fixed"\n---\n# body\n',
        staleMetadataJson,
        item.id
      )

    const listed = (await caller.listItems({ scope: 'library', type: 'skill' })) as Array<{
      id: string
      metadata_json: string
    }>
    const derived = listed.find((row) => row.id === item.id)
    expect(derived).toBeTruthy()
    const returnedMetadata = JSON.parse(derived!.metadata_json) as {
      skillValidation?: { status?: string }
    }
    expect(returnedMetadata.skillValidation?.status).toBe('valid')

    const stored = h.db
      .prepare('SELECT metadata_json FROM ai_config_items WHERE id = ?')
      .get(item.id) as { metadata_json: string }
    expect(stored.metadata_json).toBe(staleMetadataJson)
  })

  test('recomputes stale invalid metadata to valid from current content', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'stale-invalid-repair',
      content: '# body'
    })) as { id: string; metadata_json: string }

    const staleMeta = JSON.parse(item.metadata_json) as Record<string, unknown>
    staleMeta.skillCanonical = {
      frontmatter: { name: 'stale-invalid-repair', description: 'old broken parse' },
      explicitFrontmatter: false
    }
    staleMeta.skillValidation = {
      status: 'invalid',
      issues: [{ code: 'frontmatter_invalid_line', severity: 'error', message: 'stale issue', line: 4 }]
    }
    h.db
      .prepare('UPDATE ai_config_items SET content = ?, metadata_json = ? WHERE id = ?')
      .run(
        '---\nname: stale-invalid-repair\ndescription: |\n  Multi-line\n  Description\n---\n# body',
        JSON.stringify(staleMeta),
        item.id
      )

    const listed = (await caller.listItems({ scope: 'library', type: 'skill' })) as Array<{
      id: string
      content: string
      metadata_json: string
    }>
    const repaired = listed.find((row) => row.id === item.id)
    expect(repaired).toBeTruthy()
    expect(repaired!.content.includes('---\nname: stale-invalid-repair')).toBe(true)
    expect(repaired!.content.includes('# body')).toBe(true)
    const metadata = JSON.parse(repaired!.metadata_json) as { skillValidation?: { status?: string } }
    expect(metadata.skillValidation?.status).toBe('valid')
  })

  test('recomputes stale valid metadata to invalid from current content', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'stale-valid-repair',
      content: '# body'
    })) as { id: string; metadata_json: string }

    const staleMeta = JSON.parse(item.metadata_json) as Record<string, unknown>
    staleMeta.skillCanonical = {
      frontmatter: { name: 'stale-valid-repair', description: 'appears valid' },
      explicitFrontmatter: true
    }
    staleMeta.skillValidation = { status: 'valid', issues: [] }
    h.db
      .prepare('UPDATE ai_config_items SET content = ?, metadata_json = ? WHERE id = ?')
      .run('---\nname: stale-valid-repair\ntags: [one, two\n---\n# body', JSON.stringify(staleMeta), item.id)

    const listed = (await caller.listItems({ scope: 'library', type: 'skill' })) as Array<{
      id: string
      metadata_json: string
    }>
    const repaired = listed.find((row) => row.id === item.id)
    expect(repaired).toBeTruthy()
    const metadata = JSON.parse(repaired!.metadata_json) as {
      skillValidation?: { status?: string; issues?: Array<{ code?: string }> }
    }
    expect(metadata.skillValidation?.status).toBe('invalid')
    expect(metadata.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_invalid_line')).toBe(
      true
    )
  })

  test('drops legacy canonical metadata and marks body-only legacy content invalid at runtime', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'stale-missing-frontmatter',
      content: skillDoc('stale-missing-frontmatter', '# body')
    })) as { id: string; metadata_json: string }

    const staleMeta = JSON.parse(item.metadata_json) as Record<string, unknown>
    staleMeta.skillCanonical = {
      frontmatter: { name: 'stale-missing-frontmatter', description: 'stale' },
      explicitFrontmatter: true
    }
    staleMeta.skillValidation = { status: 'valid', issues: [] }
    h.db
      .prepare('UPDATE ai_config_items SET content = ?, metadata_json = ? WHERE id = ?')
      .run(
        'Create a new release for SlayZone.\nThe version argument is: patch\n',
        JSON.stringify(staleMeta),
        item.id
      )

    const listed = (await caller.listItems({ scope: 'library', type: 'skill' })) as Array<{
      id: string
      content: string
      metadata_json: string
    }>
    const repaired = listed.find((row) => row.id === item.id)
    expect(repaired).toBeTruthy()
    expect(repaired!.content).toBe('Create a new release for SlayZone.\nThe version argument is: patch\n')

    const metadata = JSON.parse(repaired!.metadata_json) as {
      skillValidation?: { status?: string; issues?: Array<{ code?: string }> }
    }
    expect(metadata.skillValidation?.status).toBe('invalid')
    expect(metadata.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_missing')).toBe(true)
  })

  test('marks new body-only skills invalid when no canonical frontmatter exists', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'new-missing-frontmatter',
      content: 'Create a new release for SlayZone.\nThe version argument is: patch\n'
    })) as { metadata_json: string }

    const metadata = JSON.parse(item.metadata_json) as {
      skillValidation?: { status?: string; issues?: Array<{ code?: string }> }
    }
    expect(metadata.skillValidation?.status).toBe('invalid')
    expect(metadata.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_missing')).toBe(true)
  })
})

await describe('getItem: raw storage', () => {
  test('returns raw skill documents from storage', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'get-item-managed-frontmatter',
      content: skillDoc('get-item-managed-frontmatter', '# managed')
    })) as { id: string }

    const stored = h.db
      .prepare('SELECT content, metadata_json FROM ai_config_items WHERE id = ?')
      .get(item.id) as { content: string; metadata_json: string }
    expect(stored.content.includes('---\nname: get-item-managed-frontmatter')).toBe(true)
    expect(stored.content.includes('# managed\n')).toBe(true)

    const loaded = (await caller.getItem({ id: item.id })) as {
      content: string
      metadata_json: string
    }
    expect(loaded.content.includes('---\nname: get-item-managed-frontmatter')).toBe(true)
    expect(loaded.content.includes('# managed\n')).toBe(true)

    const metadata = JSON.parse(loaded.metadata_json) as { skillValidation?: { status?: string } }
    expect(metadata.skillValidation?.status).toBe('valid')
  })
})

await describe('updateItem: skill validation', () => {
  test('marks managed skills invalid when they are updated without frontmatter', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'update-missing-frontmatter',
      content: skillDoc('update-missing-frontmatter', '# initial')
    })) as { id: string; content: string; metadata_json: string }

    const updated = (await caller.updateItem({
      id: item.id,
      content: 'You are evaluating a competitor for the SlayZone comparison table.\n'
    })) as { content: string; metadata_json: string }

    expect(updated.content).toBe('You are evaluating a competitor for the SlayZone comparison table.\n')
    const metadata = JSON.parse(updated.metadata_json) as {
      skillValidation?: { status?: string; issues?: Array<{ code?: string }> }
    }
    expect(metadata.skillValidation?.status).toBe('invalid')
    expect(metadata.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_missing')).toBe(true)
  })

  test('treats new and previously explicit body-only content the same', async () => {
    const created = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'update-state-parity-created',
      content: 'Create a new release for SlayZone.\n'
    })) as { id: string }

    const previouslyExplicit = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'update-state-parity-updated',
      content: skillDoc('update-state-parity-updated', '# valid first')
    })) as { id: string }
    await caller.updateItem({
      id: previouslyExplicit.id,
      content: 'Create a new release for SlayZone.\n'
    })

    const createdMeta = readSkillMetadata(created.id)
    const updatedMeta = readSkillMetadata(previouslyExplicit.id)
    expect(createdMeta.skillValidation?.status).toBe('invalid')
    expect(updatedMeta.skillValidation?.status).toBe('invalid')
    expect(createdMeta.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_missing')).toBe(
      true
    )
    expect(updatedMeta.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_missing')).toBe(
      true
    )
  })
})

await describe('loadLibraryItem', () => {
  test('writes skill to provider dir with manual path', async () => {
    // slug 'deploy-lib' (handler test used 'deploy'): one shared harness DB means
    // library slugs must stay unique across the merged suites — the items suite
    // already holds a library 'deploy'.
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'deploy-lib',
      content: skillDoc('deploy-lib', '# Deploy skill')
    })) as { id: string }

    const result = (await caller.loadLibraryItem({
      projectId: ctxProjectId,
      projectPath: root,
      itemId: item.id,
      providers: ['claude'],
      manualPath: '.claude/skills/manual/deploy.md'
    })) as { relativePath: string; syncHealth: string }
    expect(result.relativePath).toBe('.claude/skills/manual/deploy.md')
    expect(result.syncHealth).toBe('synced')
    expect(fs.readFileSync(path.join(root, '.claude/skills/manual/deploy.md'), 'utf-8').trim()).toBe(
      '# Deploy skill'
    )
  })

  test('writes skill to codex provider path', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'codex-skill',
      content: skillDoc('codex-skill', '# Codex skill')
    })) as { id: string }

    await caller.loadLibraryItem({
      projectId: ctxProjectId,
      projectPath: root,
      itemId: item.id,
      providers: ['codex']
    })
    const codexContent = fs.readFileSync(path.join(root, '.agents/skills/codex-skill/SKILL.md'), 'utf-8')
    expect(codexContent.includes('name: codex-skill')).toBe(true)
    expect(codexContent.includes('# Codex skill')).toBe(true)
  })

  test('uses selected provider semantics for manual path links', async () => {
    const fixture = createProjectFixture('manual-path-codex-provider')
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'manual-codex',
      content: skillDoc('manual-codex', '# Manual codex skill')
    })) as { id: string }

    const result = (await caller.loadLibraryItem({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['codex'],
      manualPath: '.claude/skills/manual/manual-codex.md'
    })) as { relativePath: string; provider?: string; syncHealth: string }

    expect(result.relativePath).toBe('.claude/skills/manual/manual-codex.md')
    expect(result.provider).toBe('codex')
    expect(result.syncHealth).toBe('synced')
    expect(
      fs.readFileSync(path.join(fixture.projectPath, '.claude/skills/manual/manual-codex.md'), 'utf-8').trim()
    ).toBe('# Manual codex skill')
    const selections = (await caller.listProjectSelections({ projectId: fixture.projectId })) as Array<{
      provider: string
      target_path: string
    }>
    const found = selections.find((entry) => entry.target_path === '.claude/skills/manual/manual-codex.md')
    expect(found).toBeTruthy()
    expect(found!.provider).toBe('codex')
  })

  test('rejects loading a skill with invalid frontmatter', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'invalid-frontmatter-load',
      content: '---\nname invalid\n---\n# bad frontmatter'
    })) as { id: string; metadata_json: string }

    const metadata = JSON.parse(item.metadata_json) as {
      skillValidation?: { status?: string; issues?: Array<{ code?: string }> }
    }
    expect(metadata.skillValidation?.status).toBe('invalid')
    expect(metadata.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_invalid_line')).toBe(
      true
    )

    expect(
      await didThrow(() =>
        caller.loadLibraryItem({
          projectId: ctxProjectId,
          projectPath: root,
          itemId: item.id,
          providers: ['claude']
        })
      )
    ).toBe(true)
  })

  test('accepts multiline/list YAML frontmatter as valid', async () => {
    const item = (await caller.createItem({
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
    })) as { id: string; metadata_json: string }

    const metadata = JSON.parse(item.metadata_json) as { skillValidation?: { status?: string } }
    expect(metadata.skillValidation?.status).toBe('valid')

    const result = (await caller.loadLibraryItem({
      projectId: ctxProjectId,
      projectPath: root,
      itemId: item.id,
      providers: ['claude']
    })) as { syncHealth: string }
    expect(result.syncHealth).toBe('synced')
  })

  test('rejects malformed YAML frontmatter structures', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'malformed-yaml-frontmatter',
      content: '---\nname: malformed-yaml-frontmatter\ntags: [one, two\n---\n# bad frontmatter'
    })) as { id: string; metadata_json: string }

    const metadata = JSON.parse(item.metadata_json) as {
      skillValidation?: { status?: string; issues?: Array<{ code?: string }> }
    }
    expect(metadata.skillValidation?.status).toBe('invalid')
    expect(metadata.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_invalid_line')).toBe(
      true
    )

    expect(
      await didThrow(() =>
        caller.loadLibraryItem({
          projectId: ctxProjectId,
          projectPath: root,
          itemId: item.id,
          providers: ['claude']
        })
      )
    ).toBe(true)
  })

  test('recomputes stale persisted invalid status from current valid content', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'status-invalid-authoritative',
      content: skillDoc('status-invalid-authoritative', '# body')
    })) as { id: string; metadata_json: string }

    const metadata = JSON.parse(item.metadata_json) as Record<string, unknown>
    metadata.skillValidation = { status: 'invalid', issues: [] }
    h.db.prepare('UPDATE ai_config_items SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), item.id)

    const result = (await caller.loadLibraryItem({
      projectId: ctxProjectId,
      projectPath: root,
      itemId: item.id,
      providers: ['claude']
    })) as { syncHealth: string }
    expect(result.syncHealth).toBe('synced')
  })

  test('treats persisted valid status as authoritative when stale issues are present', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'status-valid-authoritative',
      content: skillDoc('status-valid-authoritative', '# body')
    })) as { id: string; metadata_json: string }

    const metadata = JSON.parse(item.metadata_json) as Record<string, unknown>
    metadata.skillValidation = {
      status: 'valid',
      issues: [{ code: 'frontmatter_invalid_line', severity: 'error', message: 'stale issue', line: 2 }]
    }
    h.db.prepare('UPDATE ai_config_items SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), item.id)

    const result = (await caller.loadLibraryItem({
      projectId: ctxProjectId,
      projectPath: root,
      itemId: item.id,
      providers: ['claude']
    })) as { syncHealth: string }
    expect(result.syncHealth).toBe('synced')
  })

  test('rejects loading when explicit frontmatter is missing even if status was tampered to valid', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'status-valid-but-missing-frontmatter',
      content: '# no frontmatter'
    })) as { id: string; metadata_json: string }

    const metadata = JSON.parse(item.metadata_json) as Record<string, unknown>
    metadata.skillValidation = { status: 'valid', issues: [] }
    h.db.prepare('UPDATE ai_config_items SET metadata_json = ? WHERE id = ?').run(JSON.stringify(metadata), item.id)

    expect(
      await didThrow(() =>
        caller.loadLibraryItem({
          projectId: ctxProjectId,
          projectPath: root,
          itemId: item.id,
          providers: ['claude']
        })
      )
    ).toBe(true)
  })
})

await describe('syncLinkedFile', () => {
  test('re-syncs item content to disk', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'sync-test',
      content: skillDoc('sync-test', 'original')
    })) as { id: string }
    await caller.loadLibraryItem({
      projectId: ctxProjectId,
      projectPath: root,
      itemId: item.id,
      providers: ['claude'],
      manualPath: '.claude/skills/manual/sync-test.md'
    })
    fs.writeFileSync(path.join(root, '.claude/skills/manual/sync-test.md'), 'modified')
    await caller.updateItem({ id: item.id, content: skillDoc('sync-test', 'updated content') })

    const result = (await caller.syncLinkedFile({
      projectId: ctxProjectId,
      projectPath: root,
      itemId: item.id
    })) as { syncHealth: string }
    expect(result.syncHealth).toBe('synced')
    expect(fs.readFileSync(path.join(root, '.claude/skills/manual/sync-test.md'), 'utf-8')).toBe(
      'updated content\n'
    )
  })

  test('syncs all provider links for an item', async () => {
    const fixture = createProjectFixture('sync-linked-all-providers')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude', 'codex'] })
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'sync-all-providers',
      content: skillDoc('sync-all-providers', '# v1')
    })) as { id: string }

    await caller.loadLibraryItem({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude', 'codex']
    })

    const claudePath = path.join(fixture.projectPath, '.claude/skills/sync-all-providers/SKILL.md')
    const codexPath = path.join(fixture.projectPath, '.agents/skills/sync-all-providers/SKILL.md')
    fs.writeFileSync(claudePath, '# changed')
    fs.writeFileSync(codexPath, '# changed')
    await caller.updateItem({ id: item.id, content: skillDoc('sync-all-providers', '# v2') })

    await caller.syncLinkedFile({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id
    })

    expect(fs.readFileSync(claudePath, 'utf-8').includes('name: sync-all-providers')).toBe(true)
    expect(fs.readFileSync(claudePath, 'utf-8').includes('# v2')).toBe(true)
    const codexContent = fs.readFileSync(codexPath, 'utf-8')
    expect(codexContent.includes('name: sync-all-providers')).toBe(true)
    expect(codexContent.includes('# v2')).toBe(true)
  })

  test('non-claude providers keep frontmatter in synced SKILL.md files', async () => {
    const fixture = createProjectFixture('sync-codex-frontmatter')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude', 'codex'] })
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'codex-fm',
      content: skillDoc('codex-fm', '# body\n')
    })) as { id: string }

    await caller.loadLibraryItem({
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

  test('syncs project-local items without provider selections', async () => {
    const fixture = createProjectFixture('sync-linked-local-item')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude', 'codex'] })
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'project',
      projectId: fixture.projectId,
      slug: 'local-item-sync',
      content: skillDoc('local-item-sync', '# local item')
    })) as { id: string }

    await caller.syncLinkedFile({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id
    })

    const claudePath = path.join(fixture.projectPath, '.claude/skills/local-item-sync/SKILL.md')
    const codexPath = path.join(fixture.projectPath, '.agents/skills/local-item-sync/SKILL.md')
    expect(fs.readFileSync(claudePath, 'utf-8').includes('name: local-item-sync')).toBe(true)
    expect(fs.readFileSync(claudePath, 'utf-8').includes('# local item')).toBe(true)
    const codexContent = fs.readFileSync(codexPath, 'utf-8')
    expect(codexContent.includes('name: local-item-sync')).toBe(true)
    expect(codexContent.includes('# local item')).toBe(true)
  })

  test('migrates legacy claude selection paths to SKILL.md', async () => {
    const fixture = createProjectFixture('sync-linked-legacy-selection')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude'] })

    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'legacy-selection-skill',
      content: skillDoc('legacy-selection-skill', '# from library')
    })) as { id: string }

    await caller.setProjectSelection({
      projectId: fixture.projectId,
      itemId: item.id,
      provider: 'claude',
      targetPath: './.claude/skills/legacy-selection-skill.md'
    })

    const legacyPath = path.join(fixture.projectPath, '.claude/skills/legacy-selection-skill.md')
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, '# old format')

    const result = (await caller.syncLinkedFile({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id
    })) as { relativePath: string }

    const canonicalPath = path.join(fixture.projectPath, '.claude/skills/legacy-selection-skill/SKILL.md')
    expect(result.relativePath).toBe('.claude/skills/legacy-selection-skill/SKILL.md')
    expect(fs.existsSync(legacyPath)).toBe(false)
    expect(fs.readFileSync(canonicalPath, 'utf-8').includes('name: legacy-selection-skill')).toBe(true)
    expect(fs.readFileSync(canonicalPath, 'utf-8').includes('# from library')).toBe(true)
  })

  test('rejects syncing a local skill with invalid frontmatter', async () => {
    const fixture = createProjectFixture('sync-invalid-frontmatter')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude'] })
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'project',
      projectId: fixture.projectId,
      slug: 'invalid-local-skill',
      content: '---\nname invalid\n---\n# still invalid'
    })) as { id: string }

    expect(
      await didThrow(() =>
        caller.syncLinkedFile({
          projectId: fixture.projectId,
          projectPath: fixture.projectPath,
          itemId: item.id
        })
      )
    ).toBe(true)
  })

  test('rejects syncing a previously valid skill after its body is updated without frontmatter', async () => {
    const fixture = createProjectFixture('sync-missing-frontmatter-after-valid')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude'] })
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'missing-frontmatter-after-valid',
      content: skillDoc('missing-frontmatter-after-valid', '# initial')
    })) as { id: string }

    await caller.loadLibraryItem({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude']
    })

    await caller.updateItem({ id: item.id, content: 'Create a new release for SlayZone.\n' })

    expect(
      await didThrow(() =>
        caller.syncLinkedFile({
          projectId: fixture.projectId,
          projectPath: fixture.projectPath,
          itemId: item.id
        })
      )
    ).toBe(true)
  })
})

await describe('unlinkFile', () => {
  test('removes selection from DB', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'unlink-me',
      content: skillDoc('unlink-me', 'x')
    })) as { id: string }
    await caller.loadLibraryItem({
      projectId: ctxProjectId,
      projectPath: root,
      itemId: item.id,
      providers: ['claude'],
      manualPath: '.claude/skills/manual/unlink-me.md'
    })
    expect(await caller.unlinkFile({ projectId: ctxProjectId, itemId: item.id })).toBe(true)
  })

  test('returns false for nonexistent', async () => {
    expect(await caller.unlinkFile({ projectId: ctxProjectId, itemId: 'nope' })).toBe(false)
  })
})

await describe('renameContextFile', () => {
  test('renames file and updates selection target_path', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'renameme',
      content: skillDoc('renameme', 'rename content')
    })) as { id: string }
    await caller.loadLibraryItem({
      projectId: ctxProjectId,
      projectPath: root,
      itemId: item.id,
      providers: ['claude'],
      manualPath: '.claude/skills/manual/renameme.md'
    })
    const oldPath = path.join(root, '.claude/skills/manual/renameme.md')
    const newPath = path.join(root, '.claude/skills/manual/renamed.md')
    await caller.renameContextFile({ oldPath, newPath, projectPath: root })
    expect(fs.existsSync(newPath)).toBe(true)
    expect(fs.existsSync(oldPath)).toBe(false)
  })
})

await describe('deleteContextFile', () => {
  test('deletes file and removes selection', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'deleteme',
      content: skillDoc('deleteme', 'delete content')
    })) as { id: string }
    await caller.loadLibraryItem({
      projectId: ctxProjectId,
      projectPath: root,
      itemId: item.id,
      providers: ['claude'],
      manualPath: '.claude/skills/manual/deleteme.md'
    })
    const filePath = path.join(root, '.claude/skills/manual/deleteme.md')
    await caller.deleteContextFile({ filePath, projectPath: root, projectId: ctxProjectId })
    expect(fs.existsSync(filePath)).toBe(false)
  })
})

await describe('getLibraryInstructions', () => {
  test('returns empty string when none exist', async () => {
    const content = await caller.getLibraryInstructions()
    expect(content).toBe('')
  })
})

await describe('saveLibraryInstructions', () => {
  test('creates then upserts', async () => {
    await caller.saveLibraryInstructions({ content: '# Library rules v1' })
    expect(await caller.getLibraryInstructions()).toBe('# Library rules v1')
    await caller.saveLibraryInstructions({ content: '# Library rules v2' })
    expect(await caller.getLibraryInstructions()).toBe('# Library rules v2')
  })
})

await describe('saveRootInstructions', () => {
  test('writes to provider dirs and returns synced status', async () => {
    const result = (await caller.saveRootInstructions({
      projectId: ctxProjectId,
      projectPath: root,
      content: '# Project rules'
    })) as {
      content: string
      providerHealth: Record<string, { health: string; reason: string | null }>
    }
    expect(result.content).toBe('# Project rules')
    expect(result.providerHealth.claude.health).toBe('synced')
    expect(result.providerHealth.claude.reason).toBeNull()
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(true)
  })
})

await describe('getRootInstructions', () => {
  // Contract divergence vs the stale handler test: getRootInstructions returns
  // the LINKED LIBRARY VARIANT content (via recomputeInstructionsResult), NOT the
  // project root_instructions item that saveRootInstructions persists. The handler
  // test asserted it echoes saveRootInstructions output ('# Project rules') —
  // that predates the variant-based instructions model. With no linked variant it
  // returns '' + not_linked; we exercise the real contract by linking a variant.
  test('returns empty + not_linked when no library variant is linked', async () => {
    const result = (await caller.getRootInstructions({ projectId: ctxProjectId, projectPath: root })) as {
      content: string
      providerHealth: Record<string, { health: string; reason: string | null }>
    }
    expect(result.content).toBe('')
    expect(result.providerHealth.claude.health).toBe('not_synced')
    expect(result.providerHealth.claude.reason).toBe('not_linked')
  })

  test('returns linked variant content + synced provider status', async () => {
    const variantProject = createProjectFixture('root-instructions-variant')
    await caller.setProjectProviders({ projectId: variantProject.projectId, providers: ['claude'] })
    await caller.saveLibraryInstructions({ content: '# Linked variant rules' })
    const variants = (await caller.listInstructionVariants()) as Array<{ id: string; content: string }>
    const variant = variants.find((v) => v.content === '# Linked variant rules')!
    await caller.setProjectInstructionVariant({
      projectId: variantProject.projectId,
      variantItemId: variant.id,
      projectPath: variantProject.projectPath
    })

    const result = (await caller.getRootInstructions({
      projectId: variantProject.projectId,
      projectPath: variantProject.projectPath
    })) as {
      content: string
      providerHealth: Record<string, { health: string; reason: string | null }>
    }
    expect(result.content).toBe('# Linked variant rules')
    expect(result.providerHealth.claude.health).toBe('synced')
    expect(result.providerHealth.claude.reason).toBeNull()
  })
})

await describe('needsSync', () => {
  test('returns false when all synced', async () => {
    const result = await caller.needsSync({ projectId: ctxProjectId, projectPath: root })
    expect(result).toBe(false)
  })

  test('returns true when file modified externally', async () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# MODIFIED')
    const result = await caller.needsSync({ projectId: ctxProjectId, projectPath: root })
    expect(result).toBe(true)
  })

  test('ignores out-of-sync files for disabled providers', async () => {
    const fixture = createProjectFixture('needs-sync-disabled-provider')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude', 'codex'] })
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'disabled-provider-skill',
      content: skillDoc('disabled-provider-skill', '# baseline')
    })) as { id: string }

    await caller.loadLibraryItem({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['codex']
    })

    const codexPath = path.join(fixture.projectPath, '.agents/skills/disabled-provider-skill/SKILL.md')
    fs.writeFileSync(codexPath, '# modified externally')

    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude'] })
    const whileDisabled = await caller.needsSync({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath
    })
    expect(whileDisabled).toBe(false)

    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude', 'codex'] })
    const afterReEnable = await caller.needsSync({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath
    })
    expect(afterReEnable).toBe(true)
  })
})

await describe('checkSyncStatus', () => {
  test('detects external edits as conflicts', async () => {
    const conflicts = (await caller.checkSyncStatus({ projectId: ctxProjectId, projectPath: root })) as {
      path: string
      reason: string
    }[]
    expect(Array.isArray(conflicts)).toBe(true)
  })
})

await describe('discoverMcpConfigs', () => {
  test('returns entries for supported providers (codex disabled)', async () => {
    const results = (await caller.discoverMcpConfigs({ projectPath: root })) as {
      provider: string
      exists: boolean
      servers: Record<string, unknown>
    }[]
    expect(results.length).toBe(5) // claude, cursor, gemini, opencode, copilot
    const providers = results.map((r) => r.provider).sort()
    expect(providers).toContain('claude')
    expect(providers).toContain('cursor')
    expect(providers).toContain('gemini')
    expect(providers).toContain('opencode')
    expect(providers).toContain('copilot')
    expect(providers.includes('codex')).toBe(false)
  })

  test('detects existing config files', async () => {
    fs.mkdirSync(path.join(root, '.mcp-test'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'my-server': { command: 'node', args: ['server.js'] } } })
    )
    const results = (await caller.discoverMcpConfigs({ projectPath: root })) as {
      provider: string
      exists: boolean
      servers: Record<string, unknown>
    }[]
    const claude = results.find((r) => r.provider === 'claude')!
    expect(claude.exists).toBe(true)
    expect(claude.servers['my-server']).toBeTruthy()
  })
})

await describe('writeMcpServer', () => {
  test('writes server config to provider file', async () => {
    await caller.writeMcpServer({
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

  test('rejects codex writes', async () => {
    expect(
      await didThrow(() =>
        caller.writeMcpServer({
          projectPath: root,
          provider: 'codex',
          serverKey: 'test-server',
          config: { command: 'node', args: ['test.js'] }
        })
      )
    ).toBe(true)
  })
})

await describe('removeMcpServer', () => {
  test('removes server from config', async () => {
    await caller.removeMcpServer({ projectPath: root, provider: 'claude', serverKey: 'test-server' })
    const data = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf-8'))
    expect(data.mcpServers['test-server'] ?? null).toBeNull()
    expect(data.mcpServers['my-server']).toBeTruthy()
  })
})

await describe('getProjectSkillsStatus (context suite)', () => {
  test('returns status for loaded skills', async () => {
    await caller.saveRootInstructions({ projectId: ctxProjectId, projectPath: root, content: '# Project rules' })
    const skill = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'status-skill',
      content: skillDoc('status-skill', '# Status skill content')
    })) as { id: string }
    await caller.loadLibraryItem({
      projectId: ctxProjectId,
      projectPath: root,
      itemId: skill.id,
      providers: ['claude'],
      manualPath: '.claude/skills/manual/status-skill.md'
    })

    const results = (await caller.getProjectSkillsStatus({ projectId: ctxProjectId, projectPath: root })) as {
      item: { id: string; slug: string }
      providers: Record<string, { path: string; syncHealth: string; syncReason: string | null }>
    }[]
    expect(results.length).toBeGreaterThan(0)
    const found = results.find((r) => r.item.id === skill.id)
    expect(found).toBeTruthy()
    expect(found!.providers.claude).toBeTruthy()
    expect(found!.providers.claude.syncHealth).toBe('synced')
    expect(found!.providers.claude.syncReason).toBeNull()
  })

  test('detects out-of-sync skill', async () => {
    fs.writeFileSync(path.join(root, '.claude/skills/manual/status-skill.md'), '# CHANGED')
    const results = (await caller.getProjectSkillsStatus({ projectId: ctxProjectId, projectPath: root })) as {
      item: { slug: string }
      providers: Record<string, { syncHealth: string; syncReason: string | null }>
    }[]
    const found = results.find((r) => r.item.slug === 'status-skill')
    expect(found).toBeTruthy()
    expect(found!.providers.claude.syncHealth).toBe('stale')
    expect(found!.providers.claude.syncReason).toBe('external_edit')
  })

  test('marks all linked providers stale after skill body edit', async () => {
    const fixture = createProjectFixture('skills-status-body-edit')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude', 'codex'] })

    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'status-body-edit',
      content: skillDoc('status-body-edit', '# Body v1\n\nOriginal body\n')
    })) as { id: string }

    await caller.loadLibraryItem({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude', 'codex']
    })

    await caller.updateItem({ id: item.id, content: '# Body v2\n\nChanged body\n' })

    const results = (await caller.getProjectSkillsStatus({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath
    })) as Array<{
      item: { id: string }
      providers: Record<string, { syncHealth: string; syncReason: string | null }>
    }>
    const found = results.find((entry) => entry.item.id === item.id)
    expect(found).toBeTruthy()
    expect(found!.providers.claude.syncHealth).toBe('stale')
    expect(found!.providers.codex.syncHealth).toBe('stale')
  })

  test('frontmatter-only metadata changes mark all providers stale', async () => {
    const fixture = createProjectFixture('skills-status-frontmatter-edit')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude', 'codex'] })

    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'status-frontmatter-edit',
      content: skillDoc('status-frontmatter-edit', '# Shared body\n\nSame body\n')
    })) as { id: string }

    await caller.loadLibraryItem({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude', 'codex']
    })

    await caller.updateItem({ id: item.id, content: '---\nfoo: bar\n---\n\n# Shared body\n\nSame body\n' })

    const results = (await caller.getProjectSkillsStatus({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath
    })) as Array<{
      item: { id: string }
      providers: Record<string, { syncHealth: string; syncReason: string | null }>
    }>
    const found = results.find((entry) => entry.item.id === item.id)
    expect(found).toBeTruthy()
    expect(found!.providers.claude.syncHealth).toBe('stale')
    expect(found!.providers.codex.syncHealth).toBe('stale')
  })

  test('marks historically valid skills invalid when current edited content drops frontmatter', async () => {
    const fixture = createProjectFixture('skills-status-missing-frontmatter-after-valid')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude', 'codex'] })

    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'status-missing-frontmatter-after-valid',
      content: skillDoc('status-missing-frontmatter-after-valid', '# baseline')
    })) as { id: string }

    await caller.loadLibraryItem({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude', 'codex']
    })

    await caller.updateItem({ id: item.id, content: 'Create a new release for SlayZone.\n' })

    const metadata = readSkillMetadata(item.id)
    expect(metadata.skillValidation?.status).toBe('invalid')
    expect(metadata.skillValidation?.issues?.some((issue) => issue.code === 'frontmatter_missing')).toBe(true)

    const results = (await caller.getProjectSkillsStatus({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath
    })) as Array<{
      item: { id: string }
      providers: Record<string, { syncHealth: string }>
    }>
    const found = results.find((entry) => entry.item.id === item.id)
    expect(found).toBeTruthy()
    expect(found!.providers.claude.syncHealth).toBe('stale')
    expect(found!.providers.codex.syncHealth).toBe('stale')
  })
})

await describe('syncAll', () => {
  test('writes all pending files', async () => {
    const result = (await caller.syncAll({ projectId: ctxProjectId, projectPath: root })) as {
      written: { path: string; provider: string }[]
      conflicts: { path: string }[]
    }
    expect(Array.isArray(result.written)).toBe(true)
    expect(Array.isArray(result.conflicts)).toBe(true)
  })

  test('rejects sync-all when a managed skill has invalid frontmatter', async () => {
    const fixture = createProjectFixture('sync-all-invalid-frontmatter')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude'] })
    await caller.createItem({
      type: 'skill',
      scope: 'project',
      projectId: fixture.projectId,
      slug: 'broken-frontmatter-sync-all',
      content: '---\nname broken\n---\n# still invalid'
    })

    expect(
      await didThrow(() =>
        caller.syncAll({ projectId: fixture.projectId, projectPath: fixture.projectPath })
      )
    ).toBe(true)
  })

  test('rejects sync-all when a previously valid linked skill is updated with body-only content', async () => {
    const fixture = createProjectFixture('sync-all-missing-frontmatter-after-valid')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude', 'codex'] })

    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'sync-all-missing-frontmatter-after-valid',
      content: skillDoc('sync-all-missing-frontmatter-after-valid', '# initial')
    })) as { id: string }

    await caller.loadLibraryItem({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude', 'codex']
    })

    await caller.updateItem({ id: item.id, content: 'Create a new release for SlayZone.\n' })

    expect(
      await didThrow(() =>
        caller.syncAll({ projectId: fixture.projectId, projectPath: fixture.projectPath })
      )
    ).toBe(true)
  })

  test('includes project-local items in sync output and disk writes', async () => {
    const fixture = createProjectFixture('sync-all-local-items')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude', 'cursor'] })

    await caller.createItem({
      type: 'skill',
      scope: 'project',
      projectId: fixture.projectId,
      slug: 'local-project-skill',
      content: skillDoc('local-project-skill', '# local project skill')
    })
    const legacyLocalPath = path.join(fixture.projectPath, '.claude/skills/local-project-skill.md')
    fs.mkdirSync(path.dirname(legacyLocalPath), { recursive: true })
    fs.writeFileSync(legacyLocalPath, '# legacy local path')

    const result = (await caller.syncAll({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath
    })) as { written: Array<{ path: string; provider: string }> }

    expect(
      fs
        .readFileSync(path.join(fixture.projectPath, '.claude/skills/local-project-skill/SKILL.md'), 'utf-8')
        .includes('# local project skill')
    ).toBe(true)
    const cursorContent = fs.readFileSync(
      path.join(fixture.projectPath, '.cursor/skills/local-project-skill/SKILL.md'),
      'utf-8'
    )
    expect(cursorContent.includes('name: local-project-skill')).toBe(true)
    expect(cursorContent.includes('# local project skill')).toBe(true)
    expect(fs.existsSync(legacyLocalPath)).toBe(false)

    expect(
      result.written.some(
        (entry) => entry.provider === 'claude' && entry.path === '.claude/skills/local-project-skill/SKILL.md'
      )
    ).toBe(true)
    expect(
      result.written.some(
        (entry) => entry.provider === 'cursor' && entry.path === '.cursor/skills/local-project-skill/SKILL.md'
      )
    ).toBe(true)
  })

  test('does not recreate removed per-item provider links', async () => {
    const fixture = createProjectFixture('sync-all-keeps-provider-unlink')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude', 'codex'] })

    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'sync-all-provider-unlink',
      content: skillDoc('sync-all-provider-unlink', '# initial')
    })) as { id: string }

    await caller.loadLibraryItem({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude', 'codex']
    })

    await caller.removeProjectSelection({
      projectId: fixture.projectId,
      itemId: item.id,
      provider: 'codex'
    })
    await caller.updateItem({ id: item.id, content: skillDoc('sync-all-provider-unlink', '# updated') })

    const codexPath = path.join(fixture.projectPath, '.agents/skills/sync-all-provider-unlink/SKILL.md')
    const codexBefore = fs.readFileSync(codexPath, 'utf-8')

    const result = (await caller.syncAll({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath
    })) as { written: { path: string; provider: string }[]; conflicts: { path: string }[] }

    expect(result.written.some((entry) => entry.provider === 'claude')).toBe(true)
    expect(result.written.some((entry) => entry.provider === 'codex')).toBe(false)
    expect(fs.readFileSync(codexPath, 'utf-8')).toBe(codexBefore)

    const selections = (await caller.listProjectSelections({ projectId: fixture.projectId })) as Array<{
      provider: string
    }>
    expect(selections.some((row) => row.provider === 'codex')).toBe(false)
  })

  test('falls back to globally enabled providers when project settings are malformed JSON', async () => {
    const fixture = createProjectFixture('sync-all-malformed-provider-settings')
    h.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(`ai_providers:${fixture.projectId}`, '{"broken":')

    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'sync-all-fallback-provider',
      content: skillDoc('sync-all-fallback-provider', '# fallback')
    })) as { id: string }
    await caller.loadLibraryItem({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude']
    })

    const result = (await caller.syncAll({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath
    })) as { written: Array<{ provider: string }> }

    expect(result.written.some((entry) => entry.provider === 'claude')).toBe(true)
  })

  test('after pulling one provider, sync-all updates other linked providers without false conflicts', async () => {
    const fixture = createProjectFixture('sync-all-after-pull')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude', 'codex'] })

    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'sync-after-pull',
      content: skillDoc('sync-after-pull', '# baseline\n')
    })) as { id: string }

    await caller.loadLibraryItem({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude', 'codex']
    })

    const claudePath = path.join(fixture.projectPath, '.claude/skills/sync-after-pull/SKILL.md')
    const codexPath = path.join(fixture.projectPath, '.agents/skills/sync-after-pull/SKILL.md')
    fs.writeFileSync(claudePath, '---\nname: modified-on-disk\n---\n# pulled body\n')

    await caller.pullProviderSkill({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      provider: 'claude',
      itemId: item.id
    })
    const result = (await caller.syncAll({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      providers: ['claude', 'codex']
    })) as {
      written: Array<{ path: string; provider: string }>
      conflicts: Array<{ path: string; provider: string; reason: string }>
    }

    expect(result.conflicts.length).toBe(0)
    expect(
      result.written.some(
        (entry) => entry.provider === 'claude' && entry.path === '.claude/skills/sync-after-pull/SKILL.md'
      )
    ).toBe(true)
    expect(
      result.written.some(
        (entry) => entry.provider === 'codex' && entry.path === '.agents/skills/sync-after-pull/SKILL.md'
      )
    ).toBe(true)
    expect(fs.readFileSync(codexPath, 'utf-8')).toBe('---\nname: modified-on-disk\n---\n# pulled body\n')
  })

  test('prunes unmanaged skills and disabled-provider MCP configs when enabled', async () => {
    const fixture = createProjectFixture('sync-all-prune-unmanaged')
    await caller.setProjectProviders({ projectId: fixture.projectId, providers: ['claude'] })
    await caller.saveRootInstructions({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      content: '# managed instructions'
    })

    const item = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'keep-managed-skill',
      content: skillDoc('keep-managed-skill', '# keep')
    })) as { id: string }

    await caller.loadLibraryItem({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      itemId: item.id,
      providers: ['claude']
    })
    await caller.createItem({
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
    fs.writeFileSync(
      disabledProviderMcpPath,
      JSON.stringify({ mcpServers: { orphan: { command: 'npx', args: ['x'] } } }, null, 2)
    )

    const result = (await caller.syncAll({
      projectId: fixture.projectId,
      projectPath: fixture.projectPath,
      pruneUnmanaged: true
    })) as {
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

// ===========================================================================
// 4. getProjectSkillsStatus + context-tree discovery (was handlers.skills-status)
// ===========================================================================

const ssProjectId = crypto.randomUUID()
const ssProjectPath = h.tmpDir()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(ssProjectId, 'TestProj', '#000', ssProjectPath)

const ssLibrarySkill = (await caller.createItem({
  type: 'skill',
  scope: 'library',
  slug: 'status-test',
  content: '---\nname: status-test\ndescription: test skill\n---\nbody'
})) as { id: string; scope: string; project_id: string | null }

await caller.setProjectSelection({
  projectId: ssProjectId,
  itemId: ssLibrarySkill.id,
  targetPath: '.claude/skills/status-test/SKILL.md'
})

await describe('getProjectSkillsStatus (skills-status suite)', () => {
  test('returns linked library skill with correct item fields', async () => {
    const results = (await caller.getProjectSkillsStatus({
      projectId: ssProjectId,
      projectPath: ssProjectPath
    })) as Array<{
      item: { id: string; scope: string; project_id: string | null; slug: string }
      providers: Record<string, unknown>
    }>
    expect(results.length).toBeGreaterThan(0)
    const found = results.find((r) => r.item.id === ssLibrarySkill.id)
    expect(found).toBeTruthy()
    expect(found!.item.scope).toBe('library')
    expect(found!.item.slug).toBe('status-test')
  })

  test('preserves item project_id (null for library items)', async () => {
    const results = (await caller.getProjectSkillsStatus({
      projectId: ssProjectId,
      projectPath: ssProjectPath
    })) as Array<{ item: { id: string; project_id: string | null } }>
    const found = results.find((r) => r.item.id === ssLibrarySkill.id)
    expect(found).toBeTruthy()
    expect(found!.item.project_id).toBeNull()
  })

  test('returns empty for project with no linked skills', async () => {
    const emptyProjectId = crypto.randomUUID()
    h.db
      .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
      .run(emptyProjectId, 'Empty', '#000', '/tmp/empty')
    const results = (await caller.getProjectSkillsStatus({
      projectId: emptyProjectId,
      projectPath: '/tmp/empty'
    })) as unknown[]
    expect(results).toHaveLength(0)
  })

  test('project-scoped skill linked to same project preserves project_id', async () => {
    const projSkill = (await caller.createItem({
      type: 'skill',
      scope: 'project',
      projectId: ssProjectId,
      slug: 'local-status',
      content: '---\nname: local-status\ndescription: local test\n---\nbody'
    })) as { id: string; project_id: string }
    await caller.setProjectSelection({
      projectId: ssProjectId,
      itemId: projSkill.id,
      targetPath: '.claude/skills/local-status/SKILL.md'
    })
    const results = (await caller.getProjectSkillsStatus({
      projectId: ssProjectId,
      projectPath: ssProjectPath
    })) as Array<{ item: { id: string; project_id: string | null } }>
    const found = results.find((r) => r.item.id === projSkill.id)
    expect(found).toBeTruthy()
    expect(found!.item.project_id).toBe(ssProjectId)
  })
})

await describe('getContextTree discovers on-disk skills', () => {
  test('discovers unmanaged skill files in .claude/skills/', async () => {
    const skillDir = path.join(ssProjectPath, '.claude', 'skills', 'disk-only', 'SKILL.md')
    fs.mkdirSync(path.dirname(skillDir), { recursive: true })
    fs.writeFileSync(skillDir, '---\nname: disk-only\ndescription: on disk\n---\nbody')

    const entries = (await caller.getContextTree({
      projectPath: ssProjectPath,
      projectId: ssProjectId
    })) as Array<{
      relativePath: string
      category: string
      exists: boolean
      linkedItemId: string | null
      syncHealth: string
    }>
    const skillEntries = entries.filter((e) => e.category === 'skill' && e.exists)
    const diskOnly = skillEntries.find((e) => e.relativePath.includes('disk-only'))
    expect(diskOnly).toBeTruthy()
    expect(diskOnly!.linkedItemId).toBeNull()
    expect(diskOnly!.syncHealth).toBe('unmanaged')
  })

  test('linked skills show as linked in context tree', async () => {
    const linkedPath = path.join(ssProjectPath, '.claude', 'skills', 'status-test', 'SKILL.md')
    fs.mkdirSync(path.dirname(linkedPath), { recursive: true })
    fs.writeFileSync(linkedPath, '---\nname: status-test\ndescription: test skill\n---\nbody')

    const entries = (await caller.getContextTree({
      projectPath: ssProjectPath,
      projectId: ssProjectId
    })) as Array<{ relativePath: string; category: string; linkedItemId: string | null }>
    const linked = entries.find(
      (e) => e.relativePath.includes('status-test') && e.category === 'skill'
    )
    expect(linked).toBeTruthy()
    expect(linked!.linkedItemId).toBe(ssLibrarySkill.id)
  })
})

// ===========================================================================
// 5. reconcileProjectSkills (was handlers.skills-merging)
// ===========================================================================

const seedReconcileProject = (
  providers: string[] = ['claude', 'codex']
): { projectId: string; projectPath: string } => {
  const projectId = crypto.randomUUID()
  const projectPath = h.tmpDir()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
    .run(projectId, 'TestProj', '#000', projectPath)
  h.db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    .run(`ai_providers:${projectId}`, JSON.stringify(providers))
  return { projectId, projectPath }
}

const writeSkillFile = (projectPath: string, provider: string, slug: string, content?: string): void => {
  const providerDirs: Record<string, string> = { claude: '.claude/skills', codex: '.agents/skills' }
  const dir = path.join(projectPath, providerDirs[provider] ?? `.${provider}/skills`, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    content ?? `---\nname: ${slug}\ndescription: ${slug} skill\n---\n${slug} body`
  )
}

const writeFlatSkillFile = (projectPath: string, provider: string, slug: string, content?: string): void => {
  const providerDirs: Record<string, string> = { claude: '.claude/skills', codex: '.agents/skills' }
  const dir = path.join(projectPath, providerDirs[provider] ?? `.${provider}/skills`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${slug}.md`),
    content ?? `---\nname: ${slug}\ndescription: ${slug} skill\n---\n${slug} body`
  )
}

type AiConfigItem = {
  id: string
  slug: string
  name: string
  scope: string
  content: string
  project_id: string | null
}

const p2 = seedReconcileProject()

await describe('reconcile: item creation', () => {
  test('creates DB item with scope=project for disk-only skill', async () => {
    writeSkillFile(p2.projectPath, 'claude', 'new-skill')
    const count = (await caller.reconcileProjectSkills({
      projectId: p2.projectId,
      projectPath: p2.projectPath
    })) as number
    expect(count).toBe(1)

    const items = (await caller.listItems({
      scope: 'project',
      projectId: p2.projectId,
      type: 'skill'
    })) as AiConfigItem[]
    const found = items.find((i) => i.slug === 'new-skill')
    expect(found).toBeTruthy()
    expect(found!.scope).toBe('project')
  })

  test('created item content matches normalizeSkillForPersistence output', async () => {
    const diskContent = '---\nname: content-check\ndescription: verify content\n---\nthe body'
    writeSkillFile(p2.projectPath, 'claude', 'content-check', diskContent)
    await caller.reconcileProjectSkills({ projectId: p2.projectId, projectPath: p2.projectPath })

    const items = (await caller.listItems({
      scope: 'project',
      projectId: p2.projectId,
      type: 'skill'
    })) as AiConfigItem[]
    const found = items.find((i) => i.slug === 'content-check')
    expect(found).toBeTruthy()
    expect(found!.content.includes('content-check')).toBeTruthy()
    expect(found!.content.includes('the body')).toBeTruthy()
  })

  test('created item name equals normalized slug', async () => {
    writeSkillFile(p2.projectPath, 'claude', 'name-test')
    await caller.reconcileProjectSkills({ projectId: p2.projectId, projectPath: p2.projectPath })

    const items = (await caller.listItems({
      scope: 'project',
      projectId: p2.projectId,
      type: 'skill'
    })) as AiConfigItem[]
    const found = items.find((i) => i.slug === 'name-test')
    expect(found!.name).toBe('name-test')
  })

  test('empty file creates item with empty-ish content', async () => {
    writeSkillFile(p2.projectPath, 'claude', 'empty-file', '')
    await caller.reconcileProjectSkills({ projectId: p2.projectId, projectPath: p2.projectPath })

    const items = (await caller.listItems({
      scope: 'project',
      projectId: p2.projectId,
      type: 'skill'
    })) as AiConfigItem[]
    const found = items.find((i) => i.slug === 'empty-file')
    expect(found).toBeTruthy()
  })

  test('missing frontmatter → item created, name = slug', async () => {
    writeSkillFile(p2.projectPath, 'claude', 'no-fm', 'Just plain text, no frontmatter')
    await caller.reconcileProjectSkills({ projectId: p2.projectId, projectPath: p2.projectPath })

    const items = (await caller.listItems({
      scope: 'project',
      projectId: p2.projectId,
      type: 'skill'
    })) as AiConfigItem[]
    const found = items.find((i) => i.slug === 'no-fm')
    expect(found).toBeTruthy()
    expect(found!.name).toBe('no-fm')
  })

  test('malformed YAML → item created, content preserved', async () => {
    const badYaml = '---\nbad: [yaml without closing\n---\nthe body text'
    writeSkillFile(p2.projectPath, 'claude', 'bad-yaml', badYaml)
    await caller.reconcileProjectSkills({ projectId: p2.projectId, projectPath: p2.projectPath })

    const items = (await caller.listItems({
      scope: 'project',
      projectId: p2.projectId,
      type: 'skill'
    })) as AiConfigItem[]
    const found = items.find((i) => i.slug === 'bad-yaml')
    expect(found).toBeTruthy()
    expect(found!.content.includes('the body text')).toBeTruthy()
  })
})

const p3 = seedReconcileProject()

await describe('reconcile: selections', () => {
  test('claude file gets selection with canonical target_path', async () => {
    writeSkillFile(p3.projectPath, 'claude', 'sel-test')
    await caller.reconcileProjectSkills({ projectId: p3.projectId, projectPath: p3.projectPath })

    const sels = h.db
      .prepare(`
      SELECT ps.provider, ps.target_path FROM ai_config_project_selections ps
      JOIN ai_config_items i ON i.id = ps.item_id
      WHERE ps.project_id = ? AND i.slug = 'sel-test'
    `)
      .all(p3.projectId) as Array<{ provider: string; target_path: string }>
    const claude = sels.find((s) => s.provider === 'claude')
    expect(claude).toBeTruthy()
    expect(claude!.target_path).toBe('.claude/skills/sel-test/SKILL.md')
  })

  test('codex file gets selection with canonical .agents target_path', async () => {
    writeSkillFile(p3.projectPath, 'codex', 'codex-sel')
    await caller.reconcileProjectSkills({ projectId: p3.projectId, projectPath: p3.projectPath })

    const sels = h.db
      .prepare(`
      SELECT ps.provider, ps.target_path FROM ai_config_project_selections ps
      JOIN ai_config_items i ON i.id = ps.item_id
      WHERE ps.project_id = ? AND i.slug = 'codex-sel'
    `)
      .all(p3.projectId) as Array<{ provider: string; target_path: string }>
    const codex = sels.find((s) => s.provider === 'codex')
    expect(codex).toBeTruthy()
    expect(codex!.target_path).toBe('.agents/skills/codex-sel/SKILL.md')
  })

  test('same slug in .claude + .agents → 1 item, 2 selections', async () => {
    writeSkillFile(p3.projectPath, 'claude', 'dual')
    writeSkillFile(p3.projectPath, 'codex', 'dual')
    await caller.reconcileProjectSkills({ projectId: p3.projectId, projectPath: p3.projectPath })

    const items = h.db
      .prepare("SELECT * FROM ai_config_items WHERE slug = 'dual' AND scope = 'project'")
      .all() as unknown[]
    expect(items).toHaveLength(1)

    const sels = h.db
      .prepare(`
      SELECT ps.provider FROM ai_config_project_selections ps
      JOIN ai_config_items i ON i.id = ps.item_id
      WHERE ps.project_id = ? AND i.slug = 'dual'
    `)
      .all(p3.projectId) as Array<{ provider: string }>
    expect(sels).toHaveLength(2)
    expect(sels.map((s) => s.provider).sort()).toEqual(['claude', 'codex'])
  })

  test('selection target_path uses getSkillPath format', async () => {
    writeSkillFile(p3.projectPath, 'claude', 'path-format')
    await caller.reconcileProjectSkills({ projectId: p3.projectId, projectPath: p3.projectPath })

    const sels = h.db
      .prepare(`
      SELECT ps.target_path FROM ai_config_project_selections ps
      JOIN ai_config_items i ON i.id = ps.item_id
      WHERE ps.project_id = ? AND i.slug = 'path-format' AND ps.provider = 'claude'
    `)
      .all(p3.projectId) as Array<{ target_path: string }>
    expect(sels[0].target_path).toBe('.claude/skills/path-format/SKILL.md')
  })

  test('file only in .agents → single codex selection, no claude selection', async () => {
    writeSkillFile(p3.projectPath, 'codex', 'codex-only')
    await caller.reconcileProjectSkills({ projectId: p3.projectId, projectPath: p3.projectPath })

    const sels = h.db
      .prepare(`
      SELECT ps.provider FROM ai_config_project_selections ps
      JOIN ai_config_items i ON i.id = ps.item_id
      WHERE ps.project_id = ? AND i.slug = 'codex-only'
    `)
      .all(p3.projectId) as Array<{ provider: string }>
    expect(sels).toHaveLength(1)
    expect(sels[0].provider).toBe('codex')
  })
})

const p4 = seedReconcileProject()

await describe('reconcile: dedup + idempotency', () => {
  test('second call with same files returns 0', async () => {
    writeSkillFile(p4.projectPath, 'claude', 'idem-test')
    await caller.reconcileProjectSkills({ projectId: p4.projectId, projectPath: p4.projectPath })

    const count = (await caller.reconcileProjectSkills({
      projectId: p4.projectId,
      projectPath: p4.projectPath
    })) as number
    expect(count).toBe(0)
  })

  test('pre-existing project item + selection → no duplication', async () => {
    const item = (await caller.createItem({
      type: 'skill',
      scope: 'project',
      projectId: p4.projectId,
      slug: 'pre-existing',
      content: '---\nname: pre-existing\ndescription: d\n---\nb'
    })) as AiConfigItem
    await caller.setProjectSelection({
      projectId: p4.projectId,
      itemId: item.id,
      targetPath: '.claude/skills/pre-existing/SKILL.md'
    })
    writeSkillFile(p4.projectPath, 'claude', 'pre-existing')

    const count = (await caller.reconcileProjectSkills({
      projectId: p4.projectId,
      projectPath: p4.projectPath
    })) as number
    expect(count).toBe(0)
    const items = h.db
      .prepare("SELECT * FROM ai_config_items WHERE slug = 'pre-existing'")
      .all() as unknown[]
    expect(items).toHaveLength(1)
  })

  test('library item exists (no selection) + disk file → links library, count=0', async () => {
    const libraryItem = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'library-link',
      content: '---\nname: library-link\ndescription: g\n---\nb'
    })) as AiConfigItem
    writeSkillFile(p4.projectPath, 'claude', 'library-link')

    const count = (await caller.reconcileProjectSkills({
      projectId: p4.projectId,
      projectPath: p4.projectPath
    })) as number
    expect(count).toBe(0)

    const sels = h.db
      .prepare('SELECT * FROM ai_config_project_selections WHERE project_id = ? AND item_id = ?')
      .all(p4.projectId, libraryItem.id) as unknown[]
    expect(sels.length).toBeGreaterThan(0)
  })

  test('two projects share same library skill → both get selections', async () => {
    const libraryItem = (await caller.createItem({
      type: 'skill',
      scope: 'library',
      slug: 'shared-library',
      content: '---\nname: shared-library\ndescription: s\n---\nb'
    })) as AiConfigItem

    const p4b = seedReconcileProject()
    writeSkillFile(p4.projectPath, 'claude', 'shared-library')
    writeSkillFile(p4b.projectPath, 'claude', 'shared-library')

    await caller.reconcileProjectSkills({ projectId: p4.projectId, projectPath: p4.projectPath })
    await caller.reconcileProjectSkills({ projectId: p4b.projectId, projectPath: p4b.projectPath })

    const items = h.db
      .prepare("SELECT * FROM ai_config_items WHERE slug = 'shared-library'")
      .all() as unknown[]
    expect(items).toHaveLength(1)

    const selsA = h.db
      .prepare('SELECT * FROM ai_config_project_selections WHERE project_id = ? AND item_id = ?')
      .all(p4.projectId, libraryItem.id) as unknown[]
    const selsB = h.db
      .prepare('SELECT * FROM ai_config_project_selections WHERE project_id = ? AND item_id = ?')
      .all(p4b.projectId, libraryItem.id) as unknown[]
    expect(selsA.length).toBeGreaterThan(0)
    expect(selsB.length).toBeGreaterThan(0)
  })

  test('item for different project (scope=project, other project_id) → creates new item', async () => {
    const other = seedReconcileProject()
    await caller.createItem({
      type: 'skill',
      scope: 'project',
      projectId: other.projectId,
      slug: 'other-proj-skill',
      content: '---\nname: other-proj-skill\ndescription: d\n---\nb'
    })
    writeSkillFile(p4.projectPath, 'claude', 'other-proj-skill')

    const count = (await caller.reconcileProjectSkills({
      projectId: p4.projectId,
      projectPath: p4.projectPath
    })) as number
    expect(count).toBe(1)

    const items = h.db
      .prepare("SELECT * FROM ai_config_items WHERE slug = 'other-proj-skill'")
      .all() as unknown[]
    expect(items).toHaveLength(2)
  })
})

const p5 = seedReconcileProject()

await describe('reconcile: slug normalization', () => {
  test('uppercase dir name normalized to lowercase', async () => {
    writeSkillFile(p5.projectPath, 'claude', 'My-Skill')
    await caller.reconcileProjectSkills({ projectId: p5.projectId, projectPath: p5.projectPath })

    const items = (await caller.listItems({
      scope: 'project',
      projectId: p5.projectId,
      type: 'skill'
    })) as AiConfigItem[]
    expect(items.find((i) => i.slug === 'my-skill')).toBeTruthy()
  })

  test('special chars in dir replaced with hyphens', async () => {
    writeSkillFile(p5.projectPath, 'claude', 'my!!!skill')
    await caller.reconcileProjectSkills({ projectId: p5.projectId, projectPath: p5.projectPath })

    const items = (await caller.listItems({
      scope: 'project',
      projectId: p5.projectId,
      type: 'skill'
    })) as AiConfigItem[]
    expect(items.find((i) => i.slug === 'my-skill')).toBeTruthy()
  })

  test('only special chars normalizes to untitled', async () => {
    // Use a dedicated project: a library 'untitled' from the items suite exists
    // in this shared harness, so on p5 reconcile would LINK that library item
    // instead of creating a project copy (correct behaviour, but it hides the
    // project-scoped assertion). Assert via the selection join so the test holds
    // whether reconcile created a new project item or linked the library one.
    const pu = seedReconcileProject(['claude'])
    writeSkillFile(pu.projectPath, 'claude', '___')
    await caller.reconcileProjectSkills({ projectId: pu.projectId, projectPath: pu.projectPath })

    const sels = h.db
      .prepare(`
      SELECT i.slug FROM ai_config_project_selections ps
      JOIN ai_config_items i ON i.id = ps.item_id
      WHERE ps.project_id = ?
    `)
      .all(pu.projectId) as Array<{ slug: string }>
    expect(sels.some((s) => s.slug === 'untitled')).toBe(true)
  })

  test('mixed case + underscores normalized', async () => {
    writeSkillFile(p5.projectPath, 'claude', 'My_Cool_Skill')
    await caller.reconcileProjectSkills({ projectId: p5.projectId, projectPath: p5.projectPath })

    const items = (await caller.listItems({
      scope: 'project',
      projectId: p5.projectId,
      type: 'skill'
    })) as AiConfigItem[]
    expect(items.find((i) => i.slug === 'my-cool-skill')).toBeTruthy()
  })
})

const p6 = seedReconcileProject()

await describe('reconcile: edge cases', () => {
  test('no skill directories on disk → returns 0', async () => {
    const count = (await caller.reconcileProjectSkills({
      projectId: p6.projectId,
      projectPath: p6.projectPath
    })) as number
    expect(count).toBe(0)
  })

  test('empty skills dir (exists but no files) → returns 0', async () => {
    fs.mkdirSync(path.join(p6.projectPath, '.claude', 'skills'), { recursive: true })
    const count = (await caller.reconcileProjectSkills({
      projectId: p6.projectId,
      projectPath: p6.projectPath
    })) as number
    expect(count).toBe(0)
  })

  test('non-.md files in skill directory are ignored', async () => {
    const dir = path.join(p6.projectPath, '.claude', 'skills', 'has-txt')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.txt'), 'not markdown')
    fs.writeFileSync(path.join(dir, 'notes.json'), '{}')

    const count = (await caller.reconcileProjectSkills({
      projectId: p6.projectId,
      projectPath: p6.projectPath
    })) as number
    expect(count).toBe(0)
  })

  test('flat .md file creates item correctly', async () => {
    writeFlatSkillFile(p6.projectPath, 'claude', 'flat-skill')
    const count = (await caller.reconcileProjectSkills({
      projectId: p6.projectId,
      projectPath: p6.projectPath
    })) as number
    expect(count).toBe(1)

    const items = (await caller.listItems({
      scope: 'project',
      projectId: p6.projectId,
      type: 'skill'
    })) as AiConfigItem[]
    expect(items.find((i) => i.slug === 'flat-skill')).toBeTruthy()
  })

  test('backward compat agents/ dir (no dot) is NOT scanned', async () => {
    const dir = path.join(p6.projectPath, 'agents', 'not-scanned')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: not-scanned\ndescription: d\n---\nb')

    await caller.reconcileProjectSkills({ projectId: p6.projectId, projectPath: p6.projectPath })
    const items = (await caller.listItems({
      scope: 'project',
      projectId: p6.projectId,
      type: 'skill'
    })) as AiConfigItem[]
    expect(items.find((i) => i.slug === 'not-scanned')).toBeUndefined()
  })
})

const p7 = seedReconcileProject()

await describe('reconcile: file lifecycle (delete / edit)', () => {
  test('file deleted → getProjectSkillsStatus reports stale/missing_file', async () => {
    const content = '---\nname: will-delete\ndescription: d\n---\nbody'
    writeSkillFile(p7.projectPath, 'claude', 'will-delete', content)
    await caller.reconcileProjectSkills({ projectId: p7.projectId, projectPath: p7.projectPath })

    const filePath = path.join(p7.projectPath, '.claude', 'skills', 'will-delete', 'SKILL.md')
    fs.unlinkSync(filePath)

    const statuses = (await caller.getProjectSkillsStatus({
      projectId: p7.projectId,
      projectPath: p7.projectPath
    })) as Array<{
      item: { slug: string }
      providers: Record<string, { syncHealth: string; syncReason: string | null }>
    }>
    const found = statuses.find((s) => s.item.slug === 'will-delete')
    expect(found).toBeTruthy()
    const claudeStatus = found!.providers.claude
    expect(claudeStatus).toBeTruthy()
    expect(claudeStatus!.syncHealth).toBe('stale')
    expect(claudeStatus!.syncReason).toBe('missing_file')
  })

  test('file deleted → re-reconcile does NOT create duplicate item', async () => {
    const count = (await caller.reconcileProjectSkills({
      projectId: p7.projectId,
      projectPath: p7.projectPath
    })) as number
    expect(count).toBe(0)

    const items = h.db
      .prepare("SELECT * FROM ai_config_items WHERE slug = 'will-delete'")
      .all() as unknown[]
    expect(items).toHaveLength(1)
  })

  test('file externally edited → getProjectSkillsStatus reports stale/external_edit', async () => {
    const original = '---\nname: will-edit\ndescription: d\n---\noriginal body'
    writeSkillFile(p7.projectPath, 'claude', 'will-edit', original)
    await caller.reconcileProjectSkills({ projectId: p7.projectId, projectPath: p7.projectPath })

    const itemId = (
      h.db.prepare("SELECT id FROM ai_config_items WHERE slug = 'will-edit'").get() as { id: string }
    ).id
    await caller.syncLinkedFile({
      projectId: p7.projectId,
      projectPath: p7.projectPath,
      itemId,
      provider: 'claude'
    })

    const filePath = path.join(p7.projectPath, '.claude', 'skills', 'will-edit', 'SKILL.md')
    fs.writeFileSync(filePath, '---\nname: will-edit\ndescription: d\n---\nmodified body')

    const statuses = (await caller.getProjectSkillsStatus({
      projectId: p7.projectId,
      projectPath: p7.projectPath
    })) as Array<{
      item: { slug: string }
      providers: Record<string, { syncHealth: string; syncReason: string | null }>
    }>
    const found = statuses.find((s) => s.item.slug === 'will-edit')
    expect(found).toBeTruthy()
    const claudeStatus = found!.providers.claude
    expect(claudeStatus).toBeTruthy()
    expect(claudeStatus!.syncHealth).toBe('stale')
    expect(claudeStatus!.syncReason).toBe('external_edit')
  })
})

// SkillsSection source-reading tests dropped — they assert on the renderer
// component source (../client/SkillsSection.tsx) which is unrelated to the
// router contract. See report.

// ===========================================================================
// 6. Marketplace (was handlers-marketplace-sync) — marketplace.* sub-router
// ===========================================================================

type ListEntry = {
  id: string
  installed: boolean
  installed_library_item_id: string | null
  installed_project_item_id: string | null
  has_update: boolean
}

const mkt1 = seedReconcileProject(['claude'])
const entry1 = h.db
  .prepare(`SELECT id, slug FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' LIMIT 1`)
  .get() as { id: string; slug: string }

await describe('marketplace: library and project installs are independent', () => {
  test('install to library creates library item', async () => {
    const item = (await caller.marketplace.installSkill({
      entryId: entry1.id,
      scope: 'library'
    })) as AiConfigItem
    expect(item.scope).toBe('library')
    expect(item.project_id).toBeNull()
  })

  test('install to project creates separate project item', async () => {
    const item = (await caller.marketplace.installSkill({
      entryId: entry1.id,
      scope: 'project',
      projectId: mkt1.projectId
    })) as AiConfigItem
    expect(item.scope).toBe('project')
    expect(item.project_id).toBe(mkt1.projectId)
  })

  test('list-entries shows both scopes independently', async () => {
    const entries = (await caller.marketplace.listEntries({ projectId: mkt1.projectId })) as ListEntry[]
    const entry = entries.find((e) => e.id === entry1.id)
    expect(entry).toBeTruthy()
    expect(entry!.installed_library_item_id).toBeTruthy()
    expect(entry!.installed_project_item_id).toBeTruthy()
  })

  test('removing from library does not affect project', async () => {
    const entries = (await caller.marketplace.listEntries({ projectId: mkt1.projectId })) as ListEntry[]
    const entry = entries.find((e) => e.id === entry1.id)!
    await caller.deleteItem({ id: entry.installed_library_item_id! })

    const after = (await caller.marketplace.listEntries({ projectId: mkt1.projectId })) as ListEntry[]
    const updated = after.find((e) => e.id === entry1.id)!
    expect(updated.installed_library_item_id).toBeNull()
    expect(updated.installed_project_item_id).toBeTruthy()
  })

  test('removing from project does not affect library', async () => {
    await caller.marketplace.installSkill({ entryId: entry1.id, scope: 'library' })

    const entries = (await caller.marketplace.listEntries({ projectId: mkt1.projectId })) as ListEntry[]
    const entry = entries.find((e) => e.id === entry1.id)!
    await caller.deleteItem({ id: entry.installed_project_item_id! })

    const after = (await caller.marketplace.listEntries({ projectId: mkt1.projectId })) as ListEntry[]
    const updated = after.find((e) => e.id === entry1.id)!
    expect(updated.installed_library_item_id).toBeTruthy()
    expect(updated.installed_project_item_id).toBeNull()
  })
})

const mkt2 = seedReconcileProject(['claude'])
const entry2 = h.db
  .prepare(`SELECT id, slug FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' LIMIT 1`)
  .get() as { id: string; slug: string }

await describe('marketplace: install is idempotent per scope', () => {
  test('double library install returns same item', async () => {
    const first = (await caller.marketplace.installSkill({
      entryId: entry2.id,
      scope: 'library'
    })) as AiConfigItem
    const second = (await caller.marketplace.installSkill({
      entryId: entry2.id,
      scope: 'library'
    })) as AiConfigItem
    expect(second.id).toBe(first.id)
  })

  test('double project install returns same item', async () => {
    const first = (await caller.marketplace.installSkill({
      entryId: entry2.id,
      scope: 'project',
      projectId: mkt2.projectId
    })) as AiConfigItem
    const second = (await caller.marketplace.installSkill({
      entryId: entry2.id,
      scope: 'project',
      projectId: mkt2.projectId
    })) as AiConfigItem
    expect(second.id).toBe(first.id)
  })
})

const mkt3 = seedReconcileProject(['claude'])
const entry3 = h.db
  .prepare(`SELECT id, slug FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' LIMIT 1`)
  .get() as { id: string; slug: string }

await describe('marketplace: uninstall via delete-item', () => {
  test('delete-item cascades to project selections', async () => {
    const item = (await caller.marketplace.installSkill({
      entryId: entry3.id,
      scope: 'library'
    })) as AiConfigItem
    const providers = (await caller.getProjectProviders({ projectId: mkt3.projectId })) as string[]
    await caller.loadLibraryItem({
      projectId: mkt3.projectId,
      projectPath: mkt3.projectPath,
      itemId: item.id,
      providers
    })

    const selections = (await caller.listProjectSelections({ projectId: mkt3.projectId })) as {
      item_id: string
    }[]
    expect(selections.length > 0).toBe(true)

    await caller.deleteItem({ id: item.id })

    const after = (await caller.listProjectSelections({ projectId: mkt3.projectId })) as {
      item_id: string
    }[]
    expect(after.find((s) => s.item_id === item.id)).toBeUndefined()
  })
})

const mkt4 = seedReconcileProject(['claude', 'cursor'])
const entry4 = h.db
  .prepare(`SELECT id, slug FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' LIMIT 1`)
  .get() as { id: string; slug: string }

await describe('marketplace: project install + sync writes files', () => {
  test('sync-linked-file writes to all enabled providers', async () => {
    const item = (await caller.marketplace.installSkill({
      entryId: entry4.id,
      scope: 'project',
      projectId: mkt4.projectId
    })) as AiConfigItem

    await caller.syncLinkedFile({
      projectId: mkt4.projectId,
      projectPath: mkt4.projectPath,
      itemId: item.id
    })

    expect(fs.existsSync(path.join(mkt4.projectPath, '.claude', 'skills', entry4.slug, 'SKILL.md'))).toBe(
      true
    )
    expect(fs.existsSync(path.join(mkt4.projectPath, '.cursor', 'skills', entry4.slug, 'SKILL.md'))).toBe(
      true
    )
  })
})

const mkt5 = seedReconcileProject(['claude'])
const entry5 = h.db
  .prepare(`SELECT id, slug FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' LIMIT 1`)
  .get() as { id: string; slug: string }

await describe('marketplace: list-entries without projectId', () => {
  test('project-only install not visible without projectId', async () => {
    await caller.marketplace.installSkill({
      entryId: entry5.id,
      scope: 'project',
      projectId: mkt5.projectId
    })

    const entries = (await caller.marketplace.listEntries()) as ListEntry[]
    const entry = entries.find((e) => e.id === entry5.id)!
    expect(entry.installed_library_item_id).toBeNull()
    expect(entry.installed_project_item_id).toBeNull()
  })

  test('library install visible without projectId', async () => {
    await caller.marketplace.installSkill({ entryId: entry5.id, scope: 'library' })

    const entries = (await caller.marketplace.listEntries()) as ListEntry[]
    const entry = entries.find((e) => e.id === entry5.id)!
    expect(entry.installed_library_item_id).toBeTruthy()
  })
})

const mkt6 = seedReconcileProject(['claude'])
const entry6 = h.db
  .prepare(`SELECT id, slug FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' LIMIT 1`)
  .get() as { id: string; slug: string }

await describe('marketplace: slug conflict returns existing item', () => {
  test('project install with pre-existing slug returns existing item', async () => {
    const existingId = crypto.randomUUID()
    h.db
      .prepare(`
      INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at)
      VALUES (?, 'skill', 'project', ?, ?, ?, '# existing', '{}', datetime('now'), datetime('now'))
    `)
      .run(existingId, mkt6.projectId, entry6.slug, entry6.slug)

    const item = (await caller.marketplace.installSkill({
      entryId: entry6.id,
      scope: 'project',
      projectId: mkt6.projectId
    })) as AiConfigItem
    expect(item.id).toBe(existingId)
  })

  test('library install with pre-existing slug returns existing item', async () => {
    const existingId = crypto.randomUUID()
    h.db
      .prepare(`
      INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at)
      VALUES (?, 'skill', 'library', NULL, ?, ?, '# existing', '{}', datetime('now'), datetime('now'))
    `)
      .run(existingId, entry6.slug + '-library-test', entry6.slug + '-library-test')

    const entry6c = h.db
      .prepare(`SELECT id, slug FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' LIMIT 1 OFFSET 1`)
      .get() as { id: string; slug: string }

    h.db
      .prepare(`UPDATE ai_config_items SET slug = ?, name = ? WHERE id = ?`)
      .run(entry6c.slug, entry6c.slug, existingId)

    const item = (await caller.marketplace.installSkill({
      entryId: entry6c.id,
      scope: 'library'
    })) as AiConfigItem
    expect(item.id).toBe(existingId)
  })
})

const mkt7 = seedReconcileProject(['claude'])

await describe('marketplace: orphan marketplace metadata scrub', () => {
  test('item pointing at removed builtin entry loses marketplace badge on refresh', async () => {
    const itemId = crypto.randomUUID()
    const orphanMeta = {
      marketplace: {
        registryId: 'builtin-slayzone',
        registryName: 'SlayZone Built-in',
        entryId: 'builtin-ghost-skill',
        installedVersion: 'deadbeef',
        installedAt: new Date().toISOString()
      }
    }
    h.db
      .prepare(`
      INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at)
      VALUES (?, 'skill', 'project', ?, 'Ghost Skill', 'ghost-skill', '# ghost', ?, datetime('now'), datetime('now'))
    `)
      .run(itemId, mkt7.projectId, JSON.stringify(orphanMeta))

    await caller.marketplace.refreshRegistry({ registryId: 'builtin-slayzone' })

    const row = h.db.prepare('SELECT metadata_json FROM ai_config_items WHERE id = ?').get(itemId) as {
      metadata_json: string
    }
    const meta = JSON.parse(row.metadata_json) as Record<string, unknown>
    expect(meta.marketplace).toBeUndefined()
  })

  test('item pointing at valid builtin entry keeps its marketplace metadata', async () => {
    const entry = h.db
      .prepare(`SELECT id, slug, content_hash FROM skill_registry_entries WHERE registry_id = 'builtin-slayzone' LIMIT 1`)
      .get() as { id: string; slug: string; content_hash: string }
    const itemId = crypto.randomUUID()
    const validMeta = {
      marketplace: {
        registryId: 'builtin-slayzone',
        registryName: 'SlayZone Built-in',
        entryId: entry.id,
        installedVersion: entry.content_hash,
        installedAt: new Date().toISOString()
      }
    }
    h.db
      .prepare(`
      INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at)
      VALUES (?, 'skill', 'project', ?, ?, ?, '# valid', ?, datetime('now'), datetime('now'))
    `)
      .run(itemId, mkt7.projectId, entry.slug + '-valid', entry.slug + '-valid', JSON.stringify(validMeta))

    await caller.marketplace.refreshRegistry({ registryId: 'builtin-slayzone' })

    const row = h.db.prepare('SELECT metadata_json FROM ai_config_items WHERE id = ?').get(itemId) as {
      metadata_json: string
    }
    const meta = JSON.parse(row.metadata_json) as { marketplace?: { entryId?: string } }
    expect(meta.marketplace?.entryId).toBe(entry.id)
  })
})

console.log('\nDone')
