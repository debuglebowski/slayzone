import { z } from 'zod'
import type { TerminalMode } from '@slayzone/terminal/shared'
import type { CreateTaskInput } from '../types'

const terminalModeSchema = z.string().min(1) as unknown as z.ZodType<TerminalMode>

export const CreateTaskInputSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  assignee: z.string().nullable().optional(),
  status: z.string().optional(),
  priority: z.number().int().min(1).max(5).optional(),
  dueDate: z.string().optional(),
  terminalMode: terminalModeSchema.optional(),
  claudeFlags: z.string().optional(),
  codexFlags: z.string().optional(),
  cursorFlags: z.string().optional(),
  geminiFlags: z.string().optional(),
  opencodeFlags: z.string().optional(),
  parentId: z.string().optional(),
  isTemporary: z.boolean().optional(),
  repoName: z.string().nullable().optional(),
  templateId: z.string().optional(),
}) satisfies z.ZodType<CreateTaskInput>

export type { Task as CreateTaskOutput } from '../types'
