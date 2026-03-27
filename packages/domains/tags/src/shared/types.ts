export interface Tag {
  id: string
  project_id: string
  name: string
  color: string
  sort_order: number
  created_at: string
}

export interface CreateTagInput {
  name: string
  color?: string
  projectId: string
}

export interface UpdateTagInput {
  id: string
  name?: string
  color?: string
  sort_order?: number
}

export interface TaskTagInput {
  taskId: string
  tagId: string
}
