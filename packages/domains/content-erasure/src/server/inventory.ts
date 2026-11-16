import type { SlayzoneDb } from '@slayzone/platform'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ErasureManifest } from './manifest'

/** Old orphan files have lost their owner. Flag them; never guess and delete them. */
export async function hasUnattributedFiles(db: SlayzoneDb, root: string): Promise<boolean> {
  const tasks = new Set(
    (
      await db.all<{ id: string }>(
        'SELECT id FROM tasks UNION SELECT task_id AS id FROM content_erasure_tasks'
      )
    ).map((r) => r.id)
  )
  const projects = new Set(
    (await db.all<{ id: string }>('SELECT id FROM projects')).map((r) => r.id)
  )
  const hashes = new Set(
    (
      await db.all<{ hash: string }>(
        'SELECT content_hash AS hash FROM artifact_versions UNION SELECT content_hash AS hash FROM artifact_blob_pins'
      )
    ).map((r) => r.hash)
  )
  for (const row of await db.all<{ manifest: string }>(
    'SELECT manifest FROM content_erasure_jobs'
  )) {
    // One unreadable job manifest only loses its own ids: the check stays
    // conservative (more files look unattributed), never fails outright.
    let m: ErasureManifest
    try {
      m = JSON.parse(row.manifest) as ErasureManifest
    } catch {
      continue
    }
    for (const id of m.projectIds) projects.add(id)
    for (const hash of m.blobHashes) hashes.add(hash)
  }
  for (const directory of ['artifacts', 'assets']) {
    const path = join(root, directory)
    if (existsSync(path))
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (!entry.name.startsWith('.') && !tasks.has(entry.name)) return true
      }
  }
  const journals = join(root, 'artifacts', '.transactions')
  if (existsSync(journals))
    for (const entry of readdirSync(journals, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(journals, entry.name, 'manifest.json')
      if (!existsSync(path)) return true
      let taskId: unknown
      try {
        taskId = (JSON.parse(readFileSync(path, 'utf8')) as { taskId?: unknown })?.taskId
      } catch {
        return true // Unreadable: its owner is unknown, which is exactly "unattributed".
      }
      if (!tasks.has(String(taskId))) return true
    }
  const icons = join(root, 'project-icons')
  if (existsSync(icons))
    for (const entry of readdirSync(icons))
      if (!entry.startsWith('.') && !projects.has(entry.replace(/\.[^.]+$/, ''))) return true
  const blobs = join(root, 'blobs')
  if (existsSync(blobs))
    for (const bucket of readdirSync(blobs, { withFileTypes: true })) {
      if (!bucket.isDirectory()) continue
      if (bucket.name === '.tmp' && readdirSync(join(blobs, bucket.name)).length) return true
      if (/^[a-f0-9]{2}$/.test(bucket.name))
        for (const name of readdirSync(join(blobs, bucket.name))) {
          if (!hashes.has(bucket.name + name)) return true
        }
      if (bucket.name === '.gc')
        for (const hash of readdirSync(join(blobs, bucket.name))) if (!hashes.has(hash)) return true
    }
  return false
}
