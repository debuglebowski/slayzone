import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { assertPathSafeId, containedPath } from '@slayzone/platform/safe-path'
import type { TaskMoveBundle } from '@slayzone/task-contracts'
import { artifactBlobPath, artifactTaskDir, artifactsDirOf } from './artifact-paths'
import { remapCopyFilePath } from '../shared/task-copy-bundle'

export const copySnapshotRoot = (dataRoot: string, moveId: string): string =>
  containedPath(path.join(dataRoot, '.task-copy-snapshots'), assertPathSafeId(moveId, 'moveId'))

/** Immutable bytes accompany the frozen row bundle; originals remain writable. */
export function snapshotCopyFiles(dataRoot: string, bundle: TaskMoveBundle): void {
  const target = copySnapshotRoot(dataRoot, bundle.moveId)
  if (existsSync(path.join(target, '.ready'))) return
  mkdirSync(target, { recursive: true })
  for (const task of bundle.rows.tasks) {
    const source = artifactTaskDir(artifactsDirOf(dataRoot), task.id as string)
    if (existsSync(source))
      cpSync(source, artifactTaskDir(artifactsDirOf(target), task.id as string), {
        recursive: true
      })
  }
  for (const version of bundle.rows.artifact_versions) {
    const hash = version.content_hash as string
    const source = artifactBlobPath(dataRoot, hash)
    const dest = artifactBlobPath(target, hash)
    mkdirSync(path.dirname(dest), { recursive: true })
    cpSync(source, dest)
  }
  const icon = bundle.project?.rows.projects[0]?.icon_image_path
  if (typeof icon === 'string' && existsSync(icon)) {
    const dir = path.join(target, 'project-icons')
    mkdirSync(dir, { recursive: true })
    cpSync(icon, path.join(dir, path.basename(icon)))
  }
  writeFileSync(path.join(target, '.ready'), '')
}

export function dropCopySnapshot(dataRoot: string, moveId: string): void {
  rmSync(copySnapshotRoot(dataRoot, moveId), { recursive: true, force: true })
}

/** Copy working files under their new artifact IDs, preserving other file names. */
export function copyArtifactDirectory(
  source: string,
  target: string,
  ids: Record<string, string>
): void {
  if (!existsSync(source)) return
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const dest = path.join(target, remapCopyFilePath(entry.name, ids))
    if (entry.isDirectory()) copyArtifactDirectory(path.join(source, entry.name), dest, ids)
    else if (entry.isFile()) cpSync(path.join(source, entry.name), dest)
  }
}
