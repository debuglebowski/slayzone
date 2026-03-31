/**
 * CLI db-helpers tests — resolveProject
 * Run with: npx tsx --loader ./packages/shared/test-utils/loader.ts packages/apps/cli/test/db.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../shared/test-utils/ipc-harness.js'
import { createSlayDbAdapter, captureAll } from './test-harness.js'
import { resolveProject } from '../src/db-helpers.mjs'

const h = await createTestHarness()
const db = createSlayDbAdapter(h.db)

const projectId = crypto.randomUUID()
const projectId2 = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'Alpha Project', '#000')
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId2, 'Alpha Backup', '#111')

describe('resolveProject', () => {
  test('resolves by exact ID', () => {
    const p = resolveProject(db, projectId)
    expect(p.id).toBe(projectId)
    expect(p.name).toBe('Alpha Project')
  })

  test('resolves by fuzzy name match', () => {
    const p = resolveProject(db, 'Project')
    expect(p.id).toBe(projectId)
  })

  test('exits 1 when not found', () => {
    const { exitCode, stderr } = captureAll(() => resolveProject(db, 'zzz-nonexistent'))
    expect(exitCode).toBe(1)
    expect(stderr.some((s: string) => s.includes('No project matching'))).toBe(true)
  })

  test('exits 1 when ambiguous', () => {
    const { exitCode, stderr } = captureAll(() => resolveProject(db, 'Alpha'))
    expect(exitCode).toBe(1)
    expect(stderr.some((s: string) => s.includes('Ambiguous'))).toBe(true)
  })
})

h.cleanup()
console.log('\nDone')
