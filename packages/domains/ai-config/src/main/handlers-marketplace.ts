import { createHash } from 'node:crypto'
import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type {
  AddRegistryInput,
  InstallSkillInput,
  ListEntriesInput,
  SkillRegistry,
  SkillRegistryEntry,
  SkillUpdateInfo
} from '../shared/types'
import { BUILTIN_SKILLS } from '../shared/skill-marketplace-registry'
import { fetchGitHubRegistry, parseGitHubUrl } from './github-registry-fetcher'
import { normalizeSkillForPersistence } from './skill-normalize'

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function parseTagsJson(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function rowToRegistry(row: Record<string, unknown>): SkillRegistry {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? '',
    source_type: row.source_type as 'builtin' | 'github',
    github_owner: (row.github_owner as string) ?? null,
    github_repo: (row.github_repo as string) ?? null,
    github_branch: (row.github_branch as string) ?? null,
    github_path: (row.github_path as string) ?? null,
    icon_url: (row.icon_url as string) ?? null,
    enabled: !!(row.enabled as number),
    last_synced_at: (row.last_synced_at as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    entry_count: row.entry_count != null ? (row.entry_count as number) : undefined
  }
}

function rowToEntry(row: Record<string, unknown>): SkillRegistryEntry {
  return {
    id: row.id as string,
    registry_id: row.registry_id as string,
    slug: row.slug as string,
    name: row.name as string,
    description: (row.description as string) ?? '',
    content: row.content as string,
    version: (row.version as string) ?? null,
    category: (row.category as string) ?? null,
    author: (row.author as string) ?? null,
    tags: parseTagsJson(row.tags as string | null),
    content_hash: row.content_hash as string,
    fetched_at: row.fetched_at as string,
    installed: row.installed_item_id != null,
    installed_item_id: (row.installed_item_id as string) ?? null,
    has_update: row.has_update === 1,
    registry_name: (row.registry_name as string) ?? undefined
  }
}

export function registerMarketplaceHandlers(ipcMain: IpcMain, db: Database): void {
  // Ensure built-in entries are seeded
  seedBuiltinEntries(db)

  ipcMain.handle('ai-config:marketplace:list-registries', () => {
    const rows = db.prepare(`
      SELECT r.*, COUNT(e.id) as entry_count
      FROM skill_registries r
      LEFT JOIN skill_registry_entries e ON e.registry_id = r.id
      GROUP BY r.id
      ORDER BY r.source_type ASC, r.name ASC
    `).all() as Record<string, unknown>[]
    return rows.map(rowToRegistry)
  })

  ipcMain.handle('ai-config:marketplace:add-registry', async (_event, input: AddRegistryInput) => {
    const parsed = parseGitHubUrl(input.githubUrl)
    if (!parsed) throw new Error('Invalid GitHub URL. Use "owner/repo" or a full GitHub URL.')

    const existing = db.prepare(
      'SELECT id FROM skill_registries WHERE github_owner = ? AND github_repo = ?'
    ).get(parsed.owner, parsed.repo)
    if (existing) throw new Error(`Registry for ${parsed.owner}/${parsed.repo} already exists`)

    const id = crypto.randomUUID()
    const branch = input.branch ?? 'main'
    const path = input.path ?? 'skills'

    db.prepare(`
      INSERT INTO skill_registries (id, name, description, source_type, github_owner, github_repo, github_branch, github_path)
      VALUES (?, ?, ?, 'github', ?, ?, ?, ?)
    `).run(id, `${parsed.owner}/${parsed.repo}`, '', parsed.owner, parsed.repo, branch, path)

    // Immediately fetch entries
    try {
      await refreshRegistry(db, id)
    } catch {
      // Don't fail — registry is created, fetch can be retried
    }

    const row = db.prepare(`
      SELECT r.*, COUNT(e.id) as entry_count
      FROM skill_registries r
      LEFT JOIN skill_registry_entries e ON e.registry_id = r.id
      WHERE r.id = ?
      GROUP BY r.id
    `).get(id) as Record<string, unknown>
    return rowToRegistry(row)
  })

  ipcMain.handle('ai-config:marketplace:remove-registry', (_event, registryId: string) => {
    const registry = db.prepare('SELECT source_type FROM skill_registries WHERE id = ?').get(registryId) as { source_type: string } | undefined
    if (!registry) return false
    if (registry.source_type === 'builtin') throw new Error('Cannot remove built-in registries')
    db.prepare('DELETE FROM skill_registries WHERE id = ?').run(registryId)
    return true
  })

  ipcMain.handle('ai-config:marketplace:toggle-registry', (_event, registryId: string, enabled: boolean) => {
    db.prepare('UPDATE skill_registries SET enabled = ?, updated_at = datetime("now") WHERE id = ?')
      .run(enabled ? 1 : 0, registryId)
  })

  ipcMain.handle('ai-config:marketplace:ensure-fresh', async () => {
    const STALE_MS = 24 * 60 * 60 * 1000
    const registries = db.prepare(
      'SELECT id, last_synced_at FROM skill_registries WHERE enabled = 1 AND source_type = \'github\''
    ).all() as { id: string; last_synced_at: string | null }[]

    for (const reg of registries) {
      const lastSynced = reg.last_synced_at ? new Date(reg.last_synced_at + 'Z').getTime() : 0
      if (Date.now() - lastSynced > STALE_MS) {
        try {
          await refreshRegistry(db, reg.id)
        } catch (err) {
          console.error(`[marketplace] Auto-refresh failed for ${reg.id}:`, err)
        }
      }
    }
  })

  ipcMain.handle('ai-config:marketplace:refresh-registry', async (_event, registryId: string) => {
    try {
      return await refreshRegistry(db, registryId)
    } catch (err) {
      console.error(`[marketplace] Failed to refresh registry ${registryId}:`, err)
      throw err
    }
  })

  ipcMain.handle('ai-config:marketplace:refresh-all', async () => {
    const registries = db.prepare(
      'SELECT id FROM skill_registries WHERE enabled = 1'
    ).all() as { id: string }[]

    for (const r of registries) {
      try {
        await refreshRegistry(db, r.id)
      } catch (err) {
        console.error(`Failed to refresh registry ${r.id}:`, err)
      }
    }
  })

  ipcMain.handle('ai-config:marketplace:list-entries', (_event, input?: ListEntriesInput) => {
    const where: string[] = ['1=1']
    const values: unknown[] = []

    if (input?.registryId) {
      where.push('e.registry_id = ?')
      values.push(input.registryId)
    }

    if (input?.category) {
      where.push('e.category = ?')
      values.push(input.category)
    }

    if (input?.search) {
      where.push('(e.name LIKE ? OR e.description LIKE ? OR e.slug LIKE ?)')
      const q = `%${input.search}%`
      values.push(q, q, q)
    }

    // Join to detect installed status via metadata_json marketplace provenance
    const rows = db.prepare(`
      SELECT e.*,
        r.name as registry_name,
        i.id as installed_item_id,
        CASE WHEN i.id IS NOT NULL AND e.content_hash != json_extract(i.metadata_json, '$.marketplace.installedVersion')
          THEN 1 ELSE 0 END as has_update
      FROM skill_registry_entries e
      JOIN skill_registries r ON r.id = e.registry_id AND r.enabled = 1
      LEFT JOIN ai_config_items i ON json_extract(i.metadata_json, '$.marketplace.entryId') = e.id
      WHERE ${where.join(' AND ')}
      ORDER BY e.name ASC
    `).all(...values) as Record<string, unknown>[]

    return rows.map(rowToEntry)
  })

  ipcMain.handle('ai-config:marketplace:install-skill', (_event, input: InstallSkillInput) => {
    const entry = db.prepare('SELECT * FROM skill_registry_entries WHERE id = ?').get(input.entryId) as Record<string, unknown> | undefined
    if (!entry) throw new Error('Registry entry not found')

    // Check if already installed
    const existing = db.prepare(`
      SELECT id FROM ai_config_items WHERE json_extract(metadata_json, '$.marketplace.entryId') = ?
    `).get(input.entryId) as { id: string } | undefined
    if (existing) throw new Error('Skill already installed')

    const slug = entry.slug as string
    const content = entry.content as string
    const registryId = entry.registry_id as string

    const id = crypto.randomUUID()
    const scope = input.scope
    const projectId = scope === 'project' ? (input.projectId ?? null) : null

    // Normalize skill content for persistence
    const normalized = normalizeSkillForPersistence(slug, content, '{}')
    const persistedContent = normalized ? normalized.content : content
    const baseMetadata = normalized ? JSON.parse(normalized.metadataJson) : {}

    // Add marketplace provenance
    const registry = db.prepare('SELECT name FROM skill_registries WHERE id = ?').get(registryId) as { name: string } | undefined
    baseMetadata.marketplace = {
      registryId,
      registryName: registry?.name ?? null,
      entryId: input.entryId,
      installedVersion: entry.content_hash as string,
      installedAt: new Date().toISOString()
    }

    const metadataJson = JSON.stringify(baseMetadata)
    const now = new Date().toISOString()

    db.prepare(`
      INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at)
      VALUES (?, 'skill', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, scope, projectId, entry.name as string, slug, persistedContent, metadataJson, now, now)

    return db.prepare('SELECT * FROM ai_config_items WHERE id = ?').get(id)
  })

  ipcMain.handle('ai-config:marketplace:check-updates', () => {
    const rows = db.prepare(`
      SELECT i.id as item_id, e.id as entry_id, i.slug,
        json_extract(i.metadata_json, '$.marketplace.installedVersion') as current_version,
        e.content_hash as latest_version
      FROM ai_config_items i
      JOIN skill_registry_entries e ON e.id = json_extract(i.metadata_json, '$.marketplace.entryId')
      WHERE json_extract(i.metadata_json, '$.marketplace.entryId') IS NOT NULL
        AND e.content_hash != json_extract(i.metadata_json, '$.marketplace.installedVersion')
    `).all() as Array<{ item_id: string; entry_id: string; slug: string; current_version: string; latest_version: string }>

    return rows.map((r): SkillUpdateInfo => ({
      itemId: r.item_id,
      entryId: r.entry_id,
      slug: r.slug,
      currentVersion: r.current_version,
      latestVersion: r.latest_version
    }))
  })

  ipcMain.handle('ai-config:marketplace:update-skill', (_event, itemId: string, entryId: string) => {
    const entry = db.prepare('SELECT * FROM skill_registry_entries WHERE id = ?').get(entryId) as Record<string, unknown> | undefined
    if (!entry) throw new Error('Registry entry not found')

    const item = db.prepare('SELECT * FROM ai_config_items WHERE id = ?').get(itemId) as Record<string, unknown> | undefined
    if (!item) throw new Error('Installed skill not found')

    const slug = entry.slug as string
    const content = entry.content as string

    // Normalize
    const normalized = normalizeSkillForPersistence(slug, content, item.metadata_json as string)
    const persistedContent = normalized ? normalized.content : content
    const baseMetadata = normalized ? JSON.parse(normalized.metadataJson) : JSON.parse(item.metadata_json as string)

    // Update marketplace provenance
    baseMetadata.marketplace = {
      ...baseMetadata.marketplace,
      installedVersion: entry.content_hash as string,
      installedAt: new Date().toISOString()
    }

    const now = new Date().toISOString()
    db.prepare(`
      UPDATE ai_config_items SET content = ?, metadata_json = ?, updated_at = ? WHERE id = ?
    `).run(persistedContent, JSON.stringify(baseMetadata), now, itemId)

    return db.prepare('SELECT * FROM ai_config_items WHERE id = ?').get(itemId)
  })
}

async function refreshRegistry(db: Database, registryId: string): Promise<SkillRegistryEntry[]> {
  const registry = db.prepare('SELECT * FROM skill_registries WHERE id = ?').get(registryId) as Record<string, unknown> | undefined
  if (!registry) throw new Error('Registry not found')

  const sourceType = registry.source_type as string

  if (sourceType === 'builtin') {
    seedBuiltinEntries(db)
    const rows = db.prepare('SELECT * FROM skill_registry_entries WHERE registry_id = ?')
      .all(registryId) as Record<string, unknown>[]
    return rows.map(rowToEntry)
  }

  if (sourceType === 'github') {
    const result = await fetchGitHubRegistry({
      owner: registry.github_owner as string,
      repo: registry.github_repo as string,
      branch: (registry.github_branch as string) ?? 'main',
      path: (registry.github_path as string) ?? 'skills',
      etag: registry.etag as string | null
    })

    if (!result) {
      // 304 not modified
      return db.prepare('SELECT * FROM skill_registry_entries WHERE registry_id = ?')
        .all(registryId) as SkillRegistryEntry[]
    }

    // Upsert entries in a transaction
    db.transaction(() => {
      const upsert = db.prepare(`
        INSERT INTO skill_registry_entries (id, registry_id, slug, name, description, content, version, category, author, tags, content_hash, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT (registry_id, slug) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          content = excluded.content,
          version = excluded.version,
          category = excluded.category,
          author = excluded.author,
          tags = excluded.tags,
          content_hash = excluded.content_hash,
          fetched_at = excluded.fetched_at
      `)

      // Remove entries that no longer exist in the repo
      const existingSlugs = new Set(result.entries.map((e) => e.slug))
      const currentEntries = db.prepare(
        'SELECT slug FROM skill_registry_entries WHERE registry_id = ?'
      ).all(registryId) as { slug: string }[]
      for (const existing of currentEntries) {
        if (!existingSlugs.has(existing.slug)) {
          db.prepare('DELETE FROM skill_registry_entries WHERE registry_id = ? AND slug = ?')
            .run(registryId, existing.slug)
        }
      }

      for (const entry of result.entries) {
        upsert.run(
          crypto.randomUUID(),
          registryId,
          entry.slug,
          entry.name,
          entry.description,
          entry.content,
          entry.version,
          entry.category,
          entry.author,
          JSON.stringify(entry.tags),
          entry.content_hash
        )
      }

      db.prepare(`
        UPDATE skill_registries SET last_synced_at = datetime('now'), etag = ?, updated_at = datetime('now') WHERE id = ?
      `).run(result.etag, registryId)
    })()

    const rows = db.prepare('SELECT * FROM skill_registry_entries WHERE registry_id = ?')
      .all(registryId) as Record<string, unknown>[]
    return rows.map(rowToEntry)
  }

  throw new Error(`Unknown registry source type: ${sourceType}`)
}

function seedBuiltinEntries(db: Database): void {
  const registryId = 'builtin-slayzone'
  const exists = db.prepare('SELECT id FROM skill_registries WHERE id = ?').get(registryId)
  if (!exists) return

  const upsert = db.prepare(`
    INSERT INTO skill_registry_entries (id, registry_id, slug, name, description, content, version, category, author, tags, content_hash, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, 'builtin', ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (registry_id, slug) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      content = excluded.content,
      category = excluded.category,
      author = excluded.author,
      tags = excluded.tags,
      content_hash = excluded.content_hash,
      fetched_at = excluded.fetched_at
  `)

  const validSlugs = BUILTIN_SKILLS.map(s => s.slug)

  db.transaction(() => {
    for (const skill of BUILTIN_SKILLS) {
      const hash = contentHash(skill.content)
      upsert.run(
        `builtin-${skill.slug}`,
        registryId,
        skill.slug,
        skill.name,
        skill.description,
        skill.content,
        skill.category,
        skill.author,
        JSON.stringify(skill.tags),
        hash
      )
    }

    // Remove stale entries no longer in BUILTIN_SKILLS
    const placeholders = validSlugs.map(() => '?').join(', ')
    db.prepare(
      `DELETE FROM skill_registry_entries WHERE registry_id = ? AND slug NOT IN (${placeholders})`
    ).run(registryId, ...validSlugs)
  })()
}
