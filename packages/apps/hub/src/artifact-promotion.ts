/**
 * Moving a computer-held artifact to the hub (T-100): a SHARED artifact always lives on
 * the hub, so its grantees reach it whether or not the computer holding it is on.
 *
 * Every version is copied, oldest first, into a NEW hub artifact in the same task (its
 * folder too, when that folder is the hub's), names and authors kept; only then is the
 * computer's original deleted through the ordinary path — the computer removes its
 * copy and reports the deletion, so the hub's row and locator go with it. A new id,
 * not the old one re-homed: the computer is the one authority over an id it holds
 * (`reconcileFileLocation` refuses another owner for it), so a moved id would be one
 * the computer and the hub disagree about. Nothing is deleted unless the copy is whole.
 *
 * @module hub/artifact-promotion
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { openArtifactReaderOf, type ArtifactStore } from '@slayzone/task-artifacts/server'
import type { ArtifactVersion } from '@slayzone/task-artifacts/shared'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ArtifactPromotion {
  /** The artifact's id on the hub: itself when already there, else its new copy's. */
  promote(artifactId: string): Promise<string>
  /** Move every computer-held artifact of a task (and its subtasks) to the hub. */
  promoteTask(taskId: string): Promise<{ moved: number; failed: number }>
  /** Move every computer-held artifact of a project's shared tasks to the hub. */
  promoteProject(projectId: string): Promise<{ moved: number; failed: number }>
  /** Move what is still on `computerId` but shared (a retry once it is back). */
  promoteSharedOn(computerId: string): Promise<{ moved: number; failed: number }>
}

export function createArtifactPromotion(deps: {
  db: SlayzoneDb
  /** The hub's artifact API (routes a computer-held id to its computer). */
  store: () => ArtifactStore
  /** The hub's own store. */
  local: ArtifactStore
  log?: (message: string, detail?: unknown) => void
}): ArtifactPromotion {
  const { db, local } = deps
  const log = deps.log ?? ((m, d) => console.warn(`[sharing] ${m}`, d ?? ''))

  const isHeld = async (id: string): Promise<boolean> =>
    !!(await db.get('SELECT 1 FROM chat_artifact_locations WHERE artifact_id = ?', [id]))
  const folderIsHub = async (id: string | null): Promise<boolean> =>
    id === null || !(await db.get('SELECT 1 FROM chat_folder_locations WHERE folder_id = ?', [id]))

  /** One version's exact bytes, read from the computer holding it. */
  async function versionBytes(artifactId: string, ref: number | 'bytes'): Promise<Uint8Array> {
    const store = deps.store()
    const open = openArtifactReaderOf(store)
    const spec = ref === 'bytes' ? { kind: 'bytes' as const } : { kind: 'version' as const, ref }
    if (open) {
      const reader = await open(db, artifactId, spec)
      if (reader) {
        if (reader.missing) throw new Error(`artifact ${artifactId}: version ${ref} is missing`)
        const parts: Uint8Array[] = []
        for await (const chunk of reader.chunks) parts.push(chunk)
        return Buffer.concat(parts)
      }
    }
    if (ref === 'bytes') return store.readArtifactBytes(db, artifactId)
    const resolved = await store.resolveArtifactVersion(db, { artifactId, versionRef: ref })
    if (!resolved.bytes) throw new Error(`artifact ${artifactId}: version ${ref} has no bytes`)
    return resolved.bytes
  }

  /** A staged copy of `bytes` for the hub store's binary-safe create. */
  function staged<T>(bytes: Uint8Array, fn: (path: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'slz-promote-'))
    const file = join(dir, 'content')
    writeFileSync(file, bytes, { mode: 0o600 })
    return fn(file).finally(() => rmSync(dir, { recursive: true, force: true }))
  }

  async function promote(artifactId: string): Promise<string> {
    if (!(await isHeld(artifactId))) return artifactId
    const store = deps.store()
    const artifact = await store.getArtifact(db, artifactId)
    if (!artifact) throw new Error('Artifact not found')
    const versions = (
      (await store.listArtifactVersions(db, { artifactId, limit: 100_000 })) as ArtifactVersion[]
    ).sort((a, b) => a.version_num - b.version_num)
    // Read everything first: nothing is created on the hub from a partial read.
    const contents = versions.length
      ? await Promise.all(versions.map((v) => versionBytes(artifactId, v.version_num)))
      : [await versionBytes(artifactId, 'bytes')]
    const folderId = (await folderIsHub(artifact.folder_id)) ? artifact.folder_id : null
    const created = await staged(contents[0]!, (path) =>
      local.createArtifactFromStagedFile(
        db,
        {
          taskId: artifact.task_id,
          title: artifact.title,
          folderId,
          ...(artifact.render_mode ? { renderMode: artifact.render_mode } : {}),
          language: artifact.language
        },
        path
      )
    )
    if (!created) throw new Error('Could not create the hub copy')
    const first = versions[0]
    if (first?.name) {
      await local.renameArtifactVersion(db, {
        artifactId: created.id,
        versionRef: 1,
        newName: first.name
      })
    }
    for (let i = 1; i < versions.length; i++) {
      const v = versions[i]!
      const { version } = await local.writeArtifactContent(db, {
        artifactId: created.id,
        bytes: contents[i]!,
        author: { type: v.author_type, id: v.author_id }
      })
      if (v.name) {
        await local.renameArtifactVersion(db, {
          artifactId: created.id,
          versionRef: version.version_num,
          newName: v.name
        })
      }
    }
    // Grants made on the original follow it — before it goes (they cascade with it).
    await db.run('UPDATE OR IGNORE artifact_grants SET artifact_id = ? WHERE artifact_id = ?', [
      created.id,
      artifactId
    ])
    // The copy is whole: the computer's original goes the ordinary way.
    await store.deleteArtifact(db, artifactId)
    return created.id
  }

  async function promoteTask(taskId: string): Promise<{ moved: number; failed: number }> {
    return promoteAll(
      await db.all<{ id: string }>(
        `WITH RECURSIVE sub(id, depth) AS (
           SELECT ?, 0
           UNION ALL
           SELECT t.id, s.depth + 1 FROM tasks t JOIN sub s ON t.parent_id = s.id WHERE s.depth < 64)
         SELECT a.id FROM task_artifacts a JOIN chat_artifact_locations l ON l.artifact_id = a.id
          WHERE a.task_id IN (SELECT id FROM sub)`,
        [taskId]
      )
    )
  }

  async function promoteProject(projectId: string): Promise<{ moved: number; failed: number }> {
    // A project member sees its project-visible tasks; a private one is shared only
    // through its own grants (promoteTask then).
    return promoteAll(
      await db.all<{ id: string }>(
        `SELECT a.id FROM task_artifacts a JOIN chat_artifact_locations l ON l.artifact_id = a.id
           JOIN tasks t ON t.id = a.task_id
          WHERE t.project_id = ? AND NOT EXISTS (${PRIVATE_ROOT_OF('t.id')})`,
        [projectId]
      )
    )
  }

  async function promoteSharedOn(computerId: string): Promise<{ moved: number; failed: number }> {
    return promoteAll(
      await db.all<{ id: string }>(
        `SELECT a.id FROM task_artifacts a JOIN chat_artifact_locations l ON l.artifact_id = a.id
           JOIN chat_ownership o ON o.id = l.conversation_id JOIN tasks t ON t.id = a.task_id
          WHERE o.computer_id = ? AND (
            EXISTS (SELECT 1 FROM artifact_grants g WHERE g.artifact_id = a.id)
            OR EXISTS (${GRANTED_CHAIN_OF('t.id')})
            OR (EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = t.project_id)
                AND NOT EXISTS (${PRIVATE_ROOT_OF('t.id')})))`,
        [computerId]
      )
    )
  }

  async function promoteAll(rows: { id: string }[]): Promise<{ moved: number; failed: number }> {
    let moved = 0
    let failed = 0
    for (const { id } of rows) {
      try {
        await promote(id)
        moved++
      } catch (err) {
        // Its computer is away (or the copy failed): it stays there, readable while
        // that computer is on; the next share or connect tries again.
        failed++
        log('could not move a shared artifact to the hub', {
          artifactId: id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    return { moved, failed }
  }

  return { promote, promoteTask, promoteProject, promoteSharedOn }
}

/** A subquery: the task `col` (or an ancestor) is a private top-level task. */
const PRIVATE_ROOT_OF = (col: string): string => `
  WITH RECURSIVE up(id, parent_id, visibility, depth) AS (
    SELECT id, parent_id, visibility, 0 FROM tasks WHERE id = ${col}
    UNION ALL
    SELECT p.id, p.parent_id, p.visibility, u.depth + 1 FROM tasks p JOIN up u ON p.id = u.parent_id
     WHERE u.depth < 64)
  SELECT 1 FROM up WHERE parent_id IS NULL AND visibility = 'private'`

/** A subquery: the task `col` or an ancestor has a task grant. */
const GRANTED_CHAIN_OF = (col: string): string => `
  WITH RECURSIVE up(id, parent_id, depth) AS (
    SELECT id, parent_id, 0 FROM tasks WHERE id = ${col}
    UNION ALL
    SELECT p.id, p.parent_id, u.depth + 1 FROM tasks p JOIN up u ON p.id = u.parent_id
     WHERE u.depth < 64)
  SELECT 1 FROM task_grants g JOIN up ON g.task_id = up.id`
