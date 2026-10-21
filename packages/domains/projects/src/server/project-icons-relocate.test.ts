/**
 * relocateProjectIcons — repoints `projects.icon_image_path` at the hub-root
 * icons dir once the file has been copied there. The migrated DB still carries the
 * OLD absolute path (legacy userData / flat ~/.slayzone/storage), so icons only
 * rendered while that legacy dir existed.
 *
 * Run with: tsx --loader ./packages/shared/test-utils/loader.ts packages/domains/projects/src/server/project-icons-relocate.test.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { relocateProjectIcons } from './project-store.js'

const h = await createTestHarness()
const iconsDir = path.join(h.tmpDir(), 'hub', 'project-icons')
mkdirSync(iconsDir, { recursive: true })

function addProject(id: string, iconPath: string | null): void {
  h.db
    .prepare(
      "INSERT INTO projects (id, name, color, icon_image_path, updated_at) VALUES (?, ?, '#112233', ?, '2020-01-01 00:00:00')"
    )
    .run(id, id, iconPath)
}
function row(id: string): { icon_image_path: string | null; updated_at: string } {
  return h.db
    .prepare('SELECT icon_image_path, updated_at FROM projects WHERE id = ?')
    .get(id) as { icon_image_path: string | null; updated_at: string }
}

await describe('relocateProjectIcons', async () => {
  test('rewrites legacy path to the hub icons dir when the file was copied', async () => {
    writeFileSync(path.join(iconsDir, 'a.png'), 'x')
    addProject('a', '/Users/u/Library/Application Support/slayzone/project-icons/a.png')
    const n = await relocateProjectIcons(h.slayDb, iconsDir)
    expect(n).toBe(1)
    expect(row('a').icon_image_path).toBe(path.join(iconsDir, 'a.png'))
  })

  test('does not bump updated_at (not a user edit)', async () => {
    expect(row('a').updated_at).toBe('2020-01-01 00:00:00')
  })

  test('leaves the legacy path alone when the copy is absent', async () => {
    const legacy = '/Users/u/Library/Application Support/slayzone/project-icons/b.png'
    addProject('b', legacy)
    await relocateProjectIcons(h.slayDb, iconsDir)
    expect(row('b').icon_image_path).toBe(legacy)
  })

  test('leaves a path already inside the icons dir alone', async () => {
    writeFileSync(path.join(iconsDir, 'c.png'), 'x')
    const cur = path.join(iconsDir, 'c.png')
    addProject('c', cur)
    await relocateProjectIcons(h.slayDb, iconsDir)
    expect(row('c').icon_image_path).toBe(cur)
  })

  test('null icon untouched', async () => {
    addProject('d', null)
    await relocateProjectIcons(h.slayDb, iconsDir)
    expect(row('d').icon_image_path).toBe(null)
  })

  test('handles a Windows-style legacy path', async () => {
    writeFileSync(path.join(iconsDir, 'e.jpg'), 'x')
    addProject('e', 'C:\\Users\\u\\AppData\\Roaming\\slayzone\\project-icons\\e.jpg')
    await relocateProjectIcons(h.slayDb, iconsDir)
    expect(row('e').icon_image_path).toBe(path.join(iconsDir, 'e.jpg'))
  })

  test('idempotent: second run changes nothing', async () => {
    const n = await relocateProjectIcons(h.slayDb, iconsDir)
    expect(n).toBe(0)
  })

  test('missing icons dir is a no-op, not an error', async () => {
    const n = await relocateProjectIcons(h.slayDb, path.join(iconsDir, 'nope'))
    expect(n).toBe(0)
  })
})

h.cleanup()
