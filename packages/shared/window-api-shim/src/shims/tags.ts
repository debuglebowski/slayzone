import type { Tag, CreateTagInput, UpdateTagInput } from '@slayzone/tags/shared'
import { jsonRpcCall } from '../transport/mojo'

// cap-shell-13 — route tag CRUD through sidecar JSON-RPC so project_id flows
// end-to-end. TagsHost mojom Tag struct is id/name/color only, which stripped
// project_id in cap-shell-11; taskDetailCache filters `tags.filter(t =>
// t.project_id === loadedTask.project_id)` so the old path returned no tags
// for any task. Bypass mojom to thread the full row.

const nowIso = (): string => new Date().toISOString()

interface SidecarTagRow {
  id: string
  project_id: string
  name: string
  color: string
  text_color: string
  sort_order: number
}

interface SidecarWriteResult {
  ok: boolean
  error: string
  tag: SidecarTagRow
}

interface SidecarAttachResult {
  ok: boolean
  error: string
}

function toTag(row: SidecarTagRow): Tag {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    color: row.color || '#6366f1',
    text_color: row.text_color || '#ffffff',
    sort_order: row.sort_order ?? 0,
    created_at: nowIso(),
  }
}

export const tagsShim = {
  getTags: async (): Promise<Tag[]> => {
    const rows = await jsonRpcCall<SidecarTagRow[]>('tags:list', {})
    return rows.map(toTag)
  },
  createTag: async (data: CreateTagInput): Promise<Tag> => {
    const res = await jsonRpcCall<SidecarWriteResult>('tags:create', {
      name: data.name,
      color: data.color ?? '',
      textColor: data.textColor ?? '',
      projectId: data.projectId,
    })
    if (!res.ok) throw new Error(res.error || 'tags:create failed')
    return toTag(res.tag)
  },
  updateTag: async (data: UpdateTagInput): Promise<Tag> => {
    const res = await jsonRpcCall<SidecarWriteResult>('tags:update', {
      id: data.id,
      name: data.name ?? '',
      color: data.color ?? '',
      textColor: data.textColor ?? '',
    })
    if (!res.ok) throw new Error(res.error || 'tags:update failed')
    return toTag(res.tag)
  },
  deleteTag: async (id: string): Promise<boolean> => {
    const res = await jsonRpcCall<SidecarWriteResult>('tags:delete', { id })
    return res.ok
  },
  reorderTags: async (_tagIds: string[]): Promise<void> => {
    // TODO(cap-shell-14): sidecar tags handler has no reorder method; the UI
    // path that triggers this is the settings tag list drag-handle.
  },
}

export const taskTagsShim = {
  getAll: async (): Promise<Record<string, string[]>> => ({}),
  getTagsForTask: async (taskId: string): Promise<Tag[]> => {
    const rows = await jsonRpcCall<SidecarTagRow[]>('tags:for-task', { taskId })
    return rows.map(toTag)
  },
  setTagsForTask: async (taskId: string, tagIds: string[]): Promise<void> => {
    const current = await jsonRpcCall<SidecarTagRow[]>('tags:for-task', { taskId })
    const currentIds = new Set(current.map((t) => t.id))
    const nextIds = new Set(tagIds)
    for (const id of currentIds) {
      if (!nextIds.has(id)) {
        await jsonRpcCall<SidecarAttachResult>('tags:detach', { taskId, tagId: id })
      }
    }
    for (const id of nextIds) {
      if (!currentIds.has(id)) {
        await jsonRpcCall<SidecarAttachResult>('tags:attach', { taskId, tagId: id })
      }
    }
  },
}
