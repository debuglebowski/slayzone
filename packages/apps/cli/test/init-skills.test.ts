/**
 * CLI init-skills tests — resolveProjectByPath + init skills DB + file writing
 * Run: npx tsx --loader ./packages/shared/test-utils/loader.ts packages/apps/cli/test/init-skills.test.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createTestHarness, test, expect, describe } from '../../../shared/test-utils/ipc-harness.js'
import { createSlayDbAdapter, captureAll } from './test-harness.js'
import { resolveProjectByPath } from '../src/db-helpers.mjs'
import { BUILTIN_SKILLS, PROVIDER_PATHS } from '../../../domains/ai-config/src/shared/index.js'
import { createHash } from 'node:crypto'

const h = await createTestHarness()
const db = createSlayDbAdapter(h.db)

// ---------------------------------------------------------------------------
// resolveProjectByPath
// ---------------------------------------------------------------------------

const projDir = h.tmpDir()
const projId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projId, 'TestProj', '#000', projDir)

describe('resolveProjectByPath', () => {
  test('resolves exact path match', () => {
    const p = resolveProjectByPath(db, projDir)
    expect(p.id).toBe(projId)
    expect(p.name).toBe('TestProj')
    expect(p.path).toBe(projDir)
  })

  test('resolves subdirectory match', () => {
    const sub = path.join(projDir, 'src', 'components')
    const p = resolveProjectByPath(db, sub)
    expect(p.id).toBe(projId)
  })

  test('resolves with trailing slash', () => {
    const p = resolveProjectByPath(db, projDir + '/')
    expect(p.id).toBe(projId)
  })

  test('longest prefix wins for nested projects', () => {
    const nestedDir = path.join(projDir, 'packages', 'sub')
    const nestedId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(nestedId, 'NestedProj', '#111', nestedDir)

    const p = resolveProjectByPath(db, path.join(nestedDir, 'src'))
    expect(p.id).toBe(nestedId)
  })

  test('exits 1 when no project matches', () => {
    const { exitCode, stderr } = captureAll(() => resolveProjectByPath(db, '/some/other/path'))
    expect(exitCode).toBe(1)
    expect(stderr.some((s: string) => s.includes('No project found'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// init skills — DB insertion
// ---------------------------------------------------------------------------

const initProjDir = h.tmpDir()
const initProjId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(initProjId, 'InitProj', '#222', initProjDir)

/** Run the init-skills insertion logic directly (mirrors init.ts action) */
function runInitSkills(sdb: ReturnType<typeof createSlayDbAdapter>, projectId: string, projectPath: string, providers: string[] = ['claude']) {
  const registryId = 'builtin-slayzone'
  const syncedSkills: { slug: string; content: string }[] = []
  let installed = 0
  let updated = 0
  let skipped = 0

  for (const skill of BUILTIN_SKILLS) {
    const entryId = `builtin-${skill.slug}`
    const hash = createHash('sha256').update(skill.content).digest('hex')
    const now = new Date().toISOString()

    const existing = sdb.query<{ id: string; metadata_json: string }>(
      `SELECT id, metadata_json FROM ai_config_items WHERE type = 'skill' AND slug = :slug AND scope = 'project' AND project_id = :projectId`,
      { ':slug': skill.slug, ':projectId': projectId }
    )

    if (existing.length > 0) {
      const existingMeta = JSON.parse(existing[0].metadata_json || '{}') as {
        marketplace?: { installedVersion?: string; [key: string]: unknown }
        [key: string]: unknown
      }
      if (existingMeta.marketplace?.installedVersion === hash) {
        skipped++
        continue
      }
      const metadata = {
        ...existingMeta,
        marketplace: {
          ...(existingMeta.marketplace ?? {}),
          registryId,
          registryName: 'SlayZone Built-in',
          entryId,
          installedVersion: hash,
          installedAt: now,
        },
      }
      sdb.run(
        `UPDATE ai_config_items SET content = :content, metadata_json = :metadata, updated_at = :now WHERE id = :id`,
        { ':content': skill.content, ':metadata': JSON.stringify(metadata), ':now': now, ':id': existing[0].id }
      )
      syncedSkills.push({ slug: skill.slug, content: skill.content })
      updated++
      continue
    }

    const id = crypto.randomUUID()
    const metadata = {
      marketplace: { registryId, registryName: 'SlayZone Built-in', entryId, installedVersion: hash, installedAt: now }
    }

    sdb.run(
      `INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at)
       VALUES (:id, 'skill', 'project', :projectId, :name, :slug, :content, :metadata, :now, :now)`,
      { ':id': id, ':projectId': projectId, ':name': skill.name, ':slug': skill.slug, ':content': skill.content, ':metadata': JSON.stringify(metadata), ':now': now }
    )
    syncedSkills.push({ slug: skill.slug, content: skill.content })
    installed++
  }

  // Write skill files
  for (const provider of providers) {
    const mapping = PROVIDER_PATHS[provider as keyof typeof PROVIDER_PATHS]
    if (!mapping?.skillsDir) continue
    for (const skill of syncedSkills) {
      const filePath = path.join(projectPath, mapping.skillsDir, skill.slug, 'SKILL.md')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, skill.content, 'utf-8')
    }
  }

  return { installed, updated, skipped, syncedSkills }
}

describe('init skills — DB insertion', () => {
  test('inserts project-scoped skills', () => {
    const { installed } = runInitSkills(db, initProjId, initProjDir)
    expect(installed).toBe(BUILTIN_SKILLS.length)

    const rows = db.query<{ scope: string; project_id: string }>(
      `SELECT scope, project_id FROM ai_config_items WHERE type = 'skill' AND project_id = :pid`,
      { ':pid': initProjId }
    )
    expect(rows.length).toBe(BUILTIN_SKILLS.length)
    for (const row of rows) {
      expect(row.scope).toBe('project')
      expect(row.project_id).toBe(initProjId)
    }
  })

  test('skips already-installed skills on second run', () => {
    const { installed, updated, skipped } = runInitSkills(db, initProjId, initProjDir)
    expect(installed).toBe(0)
    expect(updated).toBe(0)
    expect(skipped).toBe(BUILTIN_SKILLS.length)

    // No duplicates
    const rows = db.query<{ id: string }>(
      `SELECT id FROM ai_config_items WHERE type = 'skill' AND project_id = :pid`,
      { ':pid': initProjId }
    )
    expect(rows.length).toBe(BUILTIN_SKILLS.length)
  })

  test('resyncs stale skills when registry content differs', () => {
    // Corrupt installedVersion for one skill to simulate drift
    const targetSlug = BUILTIN_SKILLS[0].slug
    const row = db.query<{ id: string; metadata_json: string }>(
      `SELECT id, metadata_json FROM ai_config_items WHERE type = 'skill' AND slug = :slug AND project_id = :pid LIMIT 1`,
      { ':slug': targetSlug, ':pid': initProjId }
    )[0]
    const meta = JSON.parse(row.metadata_json)
    meta.marketplace.installedVersion = 'stale-hash'
    db.run(`UPDATE ai_config_items SET metadata_json = :m, content = :c WHERE id = :id`, {
      ':m': JSON.stringify(meta),
      ':c': 'outdated content',
      ':id': row.id,
    })

    const { installed, updated, skipped } = runInitSkills(db, initProjId, initProjDir)
    expect(installed).toBe(0)
    expect(updated).toBe(1)
    expect(skipped).toBe(BUILTIN_SKILLS.length - 1)

    // Content was refreshed from registry
    const refreshed = db.query<{ content: string }>(
      `SELECT content FROM ai_config_items WHERE type = 'skill' AND slug = :slug AND project_id = :pid LIMIT 1`,
      { ':slug': targetSlug, ':pid': initProjId }
    )[0]
    expect(refreshed.content).toBe(BUILTIN_SKILLS[0].content)
  })
})

// ---------------------------------------------------------------------------
// init skills — file writing
// ---------------------------------------------------------------------------

const fileProjDir = h.tmpDir()
const fileProjId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(fileProjId, 'FileProj', '#333', fileProjDir)

describe('init skills — file writing', () => {
  test('writes .claude/skills/{slug}/SKILL.md for each skill', () => {
    runInitSkills(db, fileProjId, fileProjDir, ['claude'])

    for (const skill of BUILTIN_SKILLS) {
      const filePath = path.join(fileProjDir, '.claude', 'skills', skill.slug, 'SKILL.md')
      expect(fs.existsSync(filePath)).toBe(true)
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(skill.content)
    }
  })

  test('writes to multiple providers when configured', () => {
    const multiDir = h.tmpDir()
    const multiId = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(multiId, 'MultiProj', '#444', multiDir)

    runInitSkills(db, multiId, multiDir, ['claude', 'cursor'])

    const firstSlug = BUILTIN_SKILLS[0].slug
    expect(fs.existsSync(path.join(multiDir, '.claude', 'skills', firstSlug, 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(multiDir, '.cursor', 'skills', firstSlug, 'SKILL.md'))).toBe(true)
  })
})

h.cleanup()
console.log('\nDone')
