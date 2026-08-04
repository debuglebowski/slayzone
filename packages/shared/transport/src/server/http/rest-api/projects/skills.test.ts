/**
 * REST: POST /api/projects/:id/skills contract tests (`slay init` / `slay init skills`).
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/projects/skills.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { BUILTIN_SKILLS } from '@slayzone/ai-config/shared'
import { registerProjectSkillsRoute } from './skills.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'SkillProj', '#000', '/tmp/skillproj')

let notifyCount = 0
const app = express()
app.use(express.json())
registerProjectSkillsRoute(app, {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

interface SkillsBody {
  ok: boolean
  error: string
  data: {
    project: { id: string; name: string; path: string | null }
    providers: string[]
    stats: { installed: number; updated: number; skipped: number }
    skills: Array<{
      slug: string
      name: string
      content: string
      action: 'installed' | 'updated'
    }>
  }
}

function post(ref: string): Promise<{ status: number; body: SkillsBody }> {
  return rest.request<SkillsBody>('POST', `/api/projects/${encodeURIComponent(ref)}/skills`, {})
}

await describe('POST /api/projects/:id/skills', () => {
  test('happy: first run installs every builtin skill as project-scoped rows', async () => {
    notifyCount = 0
    const res = await post(projectId)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.project.id).toBe(projectId)
    expect(res.body.data.project.name).toBe('SkillProj')
    expect(res.body.data.project.path).toBe('/tmp/skillproj')
    expect(res.body.data.stats.installed).toBe(BUILTIN_SKILLS.length)
    expect(res.body.data.stats.updated).toBe(0)
    expect(res.body.data.stats.skipped).toBe(0)
    // The synced skills come back so the CLI can mirror them to disk WITHOUT
    // reading the hub's DB (and without re-deriving BUILTIN_SKILLS itself).
    expect(res.body.data.skills.length).toBe(BUILTIN_SKILLS.length)
    // Per-skill action drives the CLI's "Installed <name>" lines — the counts
    // alone cannot attribute a line to a skill.
    expect(res.body.data.skills.every((s) => s.action === 'installed')).toBe(true)
    expect(res.body.data.skills[0].name).toBe(BUILTIN_SKILLS[0].name)
    const rows = h.db
      .prepare(
        `SELECT scope, project_id, slug FROM ai_config_items WHERE type = 'skill' AND project_id = ?`
      )
      .all(projectId) as Array<{ scope: string; project_id: string; slug: string }>
    expect(rows.length).toBe(BUILTIN_SKILLS.length)
    for (const row of rows) {
      expect(row.scope).toBe('project')
      expect(row.project_id).toBe(projectId)
    }
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('happy: providers default to the terminal-mode provider when none configured', async () => {
    const res = await post(projectId)
    expect(res.body.data.providers).toEqual(['claude'])
  })

  test('happy: providers come from the ai_providers:<projectId> setting when set', async () => {
    h.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(`ai_providers:${projectId}`, JSON.stringify(['claude', 'cursor']))
    const res = await post(projectId)
    expect(res.body.data.providers).toEqual(['claude', 'cursor'])
  })

  test('content-hash comparison lives HERE: a second run skips everything', async () => {
    const res = await post(projectId)
    expect(res.body.data.stats.installed).toBe(0)
    expect(res.body.data.stats.updated).toBe(0)
    expect(res.body.data.stats.skipped).toBe(BUILTIN_SKILLS.length)
    // Nothing to mirror to disk when nothing changed.
    expect(res.body.data.skills.length).toBe(0)
    // No duplicate rows.
    const rows = h.db
      .prepare(`SELECT id FROM ai_config_items WHERE type = 'skill' AND project_id = ?`)
      .all(projectId) as Array<{ id: string }>
    expect(rows.length).toBe(BUILTIN_SKILLS.length)
  })

  test('content-hash comparison: a drifted installedVersion re-syncs that one skill', async () => {
    const targetSlug = BUILTIN_SKILLS[0].slug
    const row = h.db
      .prepare(
        `SELECT id, metadata_json FROM ai_config_items WHERE type = 'skill' AND slug = ? AND project_id = ? LIMIT 1`
      )
      .get(targetSlug, projectId) as { id: string; metadata_json: string }
    const meta = JSON.parse(row.metadata_json)
    meta.marketplace.installedVersion = 'stale-hash'
    h.db
      .prepare(`UPDATE ai_config_items SET metadata_json = ?, content = ? WHERE id = ?`)
      .run(JSON.stringify(meta), 'outdated content', row.id)

    const res = await post(projectId)
    expect(res.body.data.stats.installed).toBe(0)
    expect(res.body.data.stats.updated).toBe(1)
    expect(res.body.data.stats.skipped).toBe(BUILTIN_SKILLS.length - 1)
    expect(res.body.data.skills.length).toBe(1)
    expect(res.body.data.skills[0].slug).toBe(targetSlug)
    expect(res.body.data.skills[0].action).toBe('updated')

    const refreshed = h.db
      .prepare(
        `SELECT content, metadata_json FROM ai_config_items WHERE type = 'skill' AND slug = ? AND project_id = ? LIMIT 1`
      )
      .get(targetSlug, projectId) as { content: string; metadata_json: string }
    expect(refreshed.content).toBe(BUILTIN_SKILLS[0].content)
    // The hub re-stamped installedVersion, so the NEXT run skips it again.
    const restamped = JSON.parse(refreshed.metadata_json)
    expect(restamped.marketplace.installedVersion === 'stale-hash').toBe(false)
    const again = await post(projectId)
    expect(again.body.data.stats.skipped).toBe(BUILTIN_SKILLS.length)
  })

  test('happy: :id also accepts a case-insensitive name substring (CLI --project)', async () => {
    const res = await post('skillpr')
    expect(res.status).toBe(200)
    expect(res.body.data.project.id).toBe(projectId)
  })

  test('404: unknown project ref, naming the available projects', async () => {
    const res = await post('totally-not-a-project')
    expect(res.status).toBe(404)
    expect(res.body.ok).toBe(false)
    // The shared resolver carries the CLI's recoverable-typo hint.
    expect(res.body.error.startsWith('No project matching "totally-not-a-project".')).toBe(true)
    expect(res.body.error.includes('Available: ')).toBe(true)
  })

  test('400: ambiguous project ref lists the candidate names', async () => {
    h.db
      .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
      .run(crypto.randomUUID(), 'AmbAlpha', '#000', '/tmp/a')
    h.db
      .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
      .run(crypto.randomUUID(), 'AmbBeta', '#000', '/tmp/b')
    const res = await post('amb')
    expect(res.status).toBe(400)
    expect(res.body.error.includes('Ambiguous project "amb"')).toBe(true)
    expect(res.body.error.includes('AmbAlpha')).toBe(true)
    expect(res.body.error.includes('AmbBeta')).toBe(true)
  })

  test('no notify when nothing changed (skipped-only run)', async () => {
    notifyCount = 0
    const res = await post(projectId)
    expect(res.body.data.stats.installed + res.body.data.stats.updated).toBe(0)
    expect(notifyCount).toBe(0)
  })
})

await rest.close()
h.cleanup()
