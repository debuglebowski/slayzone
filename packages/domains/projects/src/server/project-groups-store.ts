import type { SlayzoneDb } from '@slayzone/platform'
import type {
  CreateProjectGroupInput,
  UpdateProjectGroupInput,
  Project,
  ProjectGroup,
  TopLevelEntryRef
} from '../shared'
import { parseProject } from './project-store'

// Discord-style folders (rail) + labeled collapsible sections (tree). The complex
// read-modify-write ordering lives in worker-safe named txns (projects-txns.ts);
// these fns stay thin. Mutating ops return an authoritative { projects, groups }
// snapshot the renderer replaces state with. Electron-free — the same single
// source backs the `db:project-groups:*` IPC handlers (registerProjectHandlers)
// and the tRPC `projectGroups` router (coexistence until the bridge drops).

export interface ProjectGroupsSnapshot {
  projects: Project[]
  groups: ProjectGroup[]
}

type RawSnapshot = {
  projects: (Record<string, unknown> | undefined)[]
  groups: (Record<string, unknown> | undefined)[]
}

function parseSnapshot(snap: RawSnapshot): ProjectGroupsSnapshot {
  return {
    projects: snap.projects.map((row) => parseProject(row)) as Project[],
    groups: snap.groups as unknown as ProjectGroup[]
  }
}

export async function listProjectGroups(db: SlayzoneDb): Promise<ProjectGroup[]> {
  const rows = await db.all<Record<string, unknown>>(
    'SELECT * FROM project_groups ORDER BY sort_order'
  )
  return rows as unknown as ProjectGroup[]
}

export async function createProjectGroup(
  db: SlayzoneDb,
  data: CreateProjectGroupInput
): Promise<ProjectGroupsSnapshot> {
  const now = new Date().toISOString()
  const snap = await db.namedTxn('project-groups:create', {
    id: crypto.randomUUID(),
    name: (data?.name ?? '').trim(),
    createdAt: now,
    updatedAt: now
  })
  return parseSnapshot(snap)
}

export async function createFolderWithProjects(
  db: SlayzoneDb,
  projectIds: string[]
): Promise<ProjectGroupsSnapshot> {
  if (!Array.isArray(projectIds) || projectIds.length === 0)
    throw new Error('createWith: projectIds must be a non-empty array')
  const now = new Date().toISOString()
  const snap = await db.namedTxn('project-groups:createWith', {
    id: crypto.randomUUID(),
    name: '',
    createdAt: now,
    updatedAt: now,
    projectIds
  })
  return parseSnapshot(snap)
}

export async function updateProjectGroup(
  db: SlayzoneDb,
  data: UpdateProjectGroupInput
): Promise<ProjectGroup | undefined> {
  const fields: string[] = []
  const values: unknown[] = []
  if (data.name !== undefined) {
    fields.push('name = ?')
    values.push(data.name.trim())
  }
  if (data.collapsed !== undefined) {
    fields.push('collapsed = ?')
    values.push(data.collapsed ? 1 : 0)
  }
  if (fields.length === 0) {
    return db.get<Record<string, unknown>>('SELECT * FROM project_groups WHERE id = ?', [
      data.id
    ]) as Promise<ProjectGroup | undefined>
  }
  fields.push("updated_at = datetime('now')")
  values.push(data.id)
  await db.run(`UPDATE project_groups SET ${fields.join(', ')} WHERE id = ?`, values)
  return db.get<Record<string, unknown>>('SELECT * FROM project_groups WHERE id = ?', [
    data.id
  ]) as Promise<ProjectGroup | undefined>
}

export async function deleteProjectGroup(
  db: SlayzoneDb,
  id: string
): Promise<ProjectGroupsSnapshot> {
  const snap = await db.namedTxn('project-groups:delete', { id })
  return parseSnapshot(snap)
}

export async function moveProjectToGroup(
  db: SlayzoneDb,
  projectId: string,
  groupId: string | null,
  targetIndex: number
): Promise<ProjectGroupsSnapshot> {
  const snap = await db.namedTxn('project-groups:moveProject', {
    projectId,
    groupId: groupId ?? null,
    targetIndex
  })
  return parseSnapshot(snap)
}

export async function reorderTopLevel(
  db: SlayzoneDb,
  entries: TopLevelEntryRef[]
): Promise<ProjectGroupsSnapshot> {
  if (!Array.isArray(entries)) throw new Error('reorderTopLevel: entries must be an array')
  const snap = await db.namedTxn('project-groups:reorderTopLevel', { entries })
  return parseSnapshot(snap)
}

export async function reorderProjectsInGroup(
  db: SlayzoneDb,
  groupId: string,
  projectIds: string[]
): Promise<ProjectGroupsSnapshot> {
  if (!Array.isArray(projectIds)) throw new Error('reorderWithin: projectIds must be an array')
  const snap = await db.namedTxn('project-groups:reorderWithin', { groupId, projectIds })
  return parseSnapshot(snap)
}
