import { z } from 'zod'

export const restoreTaskSchema = z.object({
  id: z.string().uuid()
})

export type RestoreTaskInput = z.infer<typeof restoreTaskSchema>
