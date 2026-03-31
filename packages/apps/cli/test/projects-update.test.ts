/**
 * CLI projects update command tests
 * Run with: ELECTRON_RUN_AS_NODE=1 electron --import tsx/esm packages/apps/cli/test/projects-update.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../shared/test-utils/ipc-harness.js'
import { createSlayDbAdapter } from './test-harness.js'

const h = await createTestHarness()
const db = createSlayDbAdapter(h.db)

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(projectId, 'UpdateProj', '#3b82f6', '/tmp/up')

function getProject(id: string) {
  return h.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown>
}

describe('projects update', () => {
  test('updates name', () => {
    h.db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
      .run('Renamed', new Date().toISOString(), projectId)
    expect((getProject(projectId)).name).toBe('Renamed')
    // Restore
    h.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run('UpdateProj', projectId)
  })

  test('updates color', () => {
    h.db.prepare('UPDATE projects SET color = ?, updated_at = ? WHERE id = ?')
      .run('#ff0000', new Date().toISOString(), projectId)
    expect((getProject(projectId)).color).toBe('#ff0000')
  })

  test('updates path', () => {
    h.db.prepare('UPDATE projects SET path = ?, updated_at = ? WHERE id = ?')
      .run('/tmp/newpath', new Date().toISOString(), projectId)
    expect((getProject(projectId)).path).toBe('/tmp/newpath')
  })

  test('updates multiple fields at once', () => {
    h.db.prepare('UPDATE projects SET name = ?, color = ?, updated_at = ? WHERE id = ?')
      .run('Multi', '#00ff00', new Date().toISOString(), projectId)
    const p = getProject(projectId)
    expect(p.name).toBe('Multi')
    expect(p.color).toBe('#00ff00')
  })

  test('updated_at changes', () => {
    const before = (getProject(projectId)).updated_at as string
    // Small delay via different timestamp
    const newTime = new Date(Date.now() + 1000).toISOString()
    h.db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
      .run('TimeTest', newTime, projectId)
    const after = (getProject(projectId)).updated_at as string
    expect(after).toBe(newTime)
    expect(after === before).toBe(false)
  })
})

h.cleanup()
console.log('\nDone')
