import { z } from 'zod'
import type { TaskStatus } from '@slayzone/task/shared'

// Task status enum matching database.ts
export const taskStatusEnum = z.enum(['inbox', 'backlog', 'todo', 'in_progress', 'review', 'done'])

// Priority 1-5
export const prioritySchema = z.number().int().min(1).max(5)

// Task creation schema - explicit non-optional for form
export const createTaskSchema = z.object({
  projectId: z.string().min(1, 'Project required'),
  title: z.string().min(1, 'Title required').max(200, 'Title too long'),
  description: z.string().max(5000),
  status: taskStatusEnum,
  priority: prioritySchema,
  dueDate: z.string().nullable(),
  tagIds: z.array(z.string())
})

// Task update schema
export const updateTaskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).nullable(),
  status: taskStatusEnum,
  priority: prioritySchema,
  dueDate: z.string().nullable()
})

// Project creation schema
export const createProjectSchema = z.object({
  name: z.string().min(1, 'Name required').max(100, 'Name too long'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Invalid hex color'),
  taskStorage: z.enum(['database', 'repository']).optional()
})

// Project update schema
export const updateProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  taskStorage: z.enum(['database', 'repository']).optional()
})

// Form data types - explicit for forms
export interface CreateTaskFormData {
  projectId: string
  title: string
  description: string
  status: TaskStatus
  priority: number
  dueDate: string | null
  tagIds: string[]
}

export interface UpdateTaskFormData {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: number
  dueDate: string | null
}

export type CreateProjectFormData = z.infer<typeof createProjectSchema>
export type UpdateProjectFormData = z.infer<typeof updateProjectSchema>

// Status options for Select
export const statusOptions = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'todo', label: 'Todo' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'review', label: 'Review' },
  { value: 'done', label: 'Done' }
] as const

// Priority options for Select
export const priorityOptions = [
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
  { value: 5, label: 'Someday' }
] as const
