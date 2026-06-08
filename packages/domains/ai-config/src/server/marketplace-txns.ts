import { createHash } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { BUILTIN_SKILLS } from '../shared/skill-marketplace-registry'
import { normalizeSkillForPersistence } from '../server/skill-normalize'

/**
 * Named-transaction adapters for the ai-config marketplace. Both are conditional
 * read-modify-writes (read existing slugs / orphan + stale rows, THEN delete or
 * update based on those values) that can't be expressed as a static op list —
 * they must run as a single function inside the DB worker. Each owns its own
 * `db.transaction(...)`, so the worker invokes it directly without re-wrapping.
 *
 * Pure: imports only better-sqlite3 + node:crypto + the worker-safe
 * `skill-normalize` and shared registry modules, so it is safe to pull into the
 * worker bundle (unlike the electron-laden `/main` barrel).
 */

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Shape of a single fetched registry entry passed into `refreshRegistryEntries`. */
export interface RefreshRegistryEntryInput {
  slug: string
  name: string
  description: string
  content: string
  version: string | null
  category?: string | null
  author: string | null
  content_hash: string
}

/**
 * Upsert fetched GitHub registry entries, prune entries no longer present in the
 * repo, and stamp the registry's last_synced_at + etag — atomically. Conditional:
 * reads current slugs and deletes the ones missing from `entries`.
 */
function refreshRegistryEntries(
  db: Database,
  registryId: string,
  entries: RefreshRegistryEntryInput[],
  etag: string | null
): void {
  db.transaction(() => {
    const upsert = db.prepare(`
        INSERT INTO skill_registry_entries (id, registry_id, slug, name, description, content, version, category, author, content_hash, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT (registry_id, slug) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          content = excluded.content,
          version = excluded.version,
          category = excluded.category,
          author = excluded.author,
          content_hash = excluded.content_hash,
          fetched_at = excluded.fetched_at
      `)

    // Remove entries that no longer exist in the repo
    const existingSlugs = new Set(entries.map((e) => e.slug))
    const currentEntries = db
      .prepare('SELECT slug FROM skill_registry_entries WHERE registry_id = ?')
      .all(registryId) as { slug: string }[]
    for (const existing of currentEntries) {
      if (!existingSlugs.has(existing.slug)) {
        db.prepare('DELETE FROM skill_registry_entries WHERE registry_id = ? AND slug = ?').run(
          registryId,
          existing.slug
        )
      }
    }

    for (const entry of entries) {
      upsert.run(
        crypto.randomUUID(),
        registryId,
        entry.slug,
        entry.name,
        entry.description,
        entry.content,
        entry.version,
        entry.category ?? 'general',
        entry.author,
        entry.content_hash
      )
    }

    db.prepare(`
        UPDATE skill_registries SET last_synced_at = datetime('now'), etag = ?, updated_at = datetime('now') WHERE id = ?
      `).run(etag, registryId)
  })()
}

/**
 * Re-seed the built-in skill registry entries from BUILTIN_SKILLS: upsert each,
 * prune stale entries, scrub orphan marketplace metadata, and auto-update
 * installed builtin skills whose content drifted — atomically. Conditional:
 * reads orphan + stale rows, then writes based on those.
 */
function seedBuiltinEntries(db: Database): void {
  const registryId = 'builtin-slayzone'
  const exists = db.prepare('SELECT id FROM skill_registries WHERE id = ?').get(registryId)
  if (!exists) return

  const upsert = db.prepare(`
    INSERT INTO skill_registry_entries (id, registry_id, slug, name, description, content, version, category, author, content_hash, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, 'builtin', ?, ?, ?, datetime('now'))
    ON CONFLICT (registry_id, slug) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      content = excluded.content,
      category = excluded.category,
      author = excluded.author,
      content_hash = excluded.content_hash,
      fetched_at = excluded.fetched_at
  `)

  const validSlugs = BUILTIN_SKILLS.map((s) => s.slug)

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
        hash
      )
    }

    // Remove stale entries no longer in BUILTIN_SKILLS
    const placeholders = validSlugs.map(() => '?').join(', ')
    db.prepare(
      `DELETE FROM skill_registry_entries WHERE registry_id = ? AND slug NOT IN (${placeholders})`
    ).run(registryId, ...validSlugs)

    // Scrub orphan marketplace metadata: items still tagged with this registry
    // but whose entryId no longer exists (e.g. skill removed from BUILTIN_SKILLS
    // but item row kept). Otherwise UI keeps showing the "built-in" badge.
    const orphans = db
      .prepare(`
      SELECT i.id, i.metadata_json
      FROM ai_config_items i
      WHERE json_extract(i.metadata_json, '$.marketplace.registryId') = ?
        AND NOT EXISTS (
          SELECT 1 FROM skill_registry_entries e
          WHERE e.id = json_extract(i.metadata_json, '$.marketplace.entryId')
        )
    `)
      .all(registryId) as Array<{ id: string; metadata_json: string }>

    for (const orphan of orphans) {
      let meta: Record<string, unknown>
      try {
        meta = JSON.parse(orphan.metadata_json) as Record<string, unknown>
      } catch {
        meta = {}
      }
      delete meta.marketplace
      db.prepare(
        `UPDATE ai_config_items SET metadata_json = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(JSON.stringify(meta), orphan.id)
    }

    // Auto-update installed builtin skills whose content is stale
    const staleItems = db
      .prepare(`
      SELECT i.id as item_id, e.id as entry_id, i.metadata_json, e.slug, e.content, e.content_hash
      FROM ai_config_items i
      JOIN skill_registry_entries e ON e.id = json_extract(i.metadata_json, '$.marketplace.entryId')
      WHERE e.registry_id = ?
        AND e.content_hash != json_extract(i.metadata_json, '$.marketplace.installedVersion')
    `)
      .all(registryId) as Array<{
      item_id: string
      entry_id: string
      metadata_json: string
      slug: string
      content: string
      content_hash: string
    }>

    for (const item of staleItems) {
      const normalized = normalizeSkillForPersistence(item.slug, item.content, item.metadata_json)
      const meta = JSON.parse(normalized.metadataJson)
      meta.marketplace = {
        ...meta.marketplace,
        installedVersion: item.content_hash,
        installedAt: new Date().toISOString()
      }
      db.prepare(
        `UPDATE ai_config_items SET content = ?, metadata_json = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(normalized.content, JSON.stringify(meta), item.item_id)
    }
  })()
}

export const marketplaceTxns = {
  'ai-config:marketplace:refresh-registry-entries': (
    db: Database,
    p: { registryId: string; entries: RefreshRegistryEntryInput[]; etag: string | null }
  ) => {
    refreshRegistryEntries(db, p.registryId, p.entries, p.etag)
    return null
  },
  'ai-config:marketplace:seed-builtin-entries': (db: Database, _p: Record<string, never>) => {
    seedBuiltinEntries(db)
    return null
  }
}
