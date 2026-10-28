import { z } from 'zod'
import type { TaskStatus } from './types'

// Status keys are project-defined at runtime.
export const taskStatusEnum = z.string().min(1)

// Priority 1-5
export const prioritySchema = z.number().int().min(1).max(5)

// Task creation schema - explicit non-optional for form
export const createTaskSchema = z.object({
  projectId: z.string().min(1, 'Project required'),
  title: z.string().min(1, 'Title required').max(200, 'Title too long'),
  description: z.string().max(10000),
  status: taskStatusEnum,
  priority: prioritySchema,
  dueDate: z.string().nullable(),
  tagIds: z.array(z.string())
})

// Task update schema
export const updateTaskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(10000).nullable(),
  status: taskStatusEnum,
  priority: prioritySchema,
  dueDate: z.string().nullable()
})

// Project creation schema
export const createProjectSchema = z.object({
  name: z.string().min(1, 'Name required').max(100, 'Name too long'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Invalid hex color')
})

// Project update schema
export const updateProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
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

// Priority options for Select
export const priorityOptions = [
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
  { value: 5, label: 'Someday' }
] as const
