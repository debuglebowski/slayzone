import { z } from 'zod'

export const deleteTaskInputSchema = z.object({
  id: z.string().uuid(),
})

export const deleteTaskOutputSchema = z.union([
  z.boolean(),
  z.object({
    blocked: z.literal(true),
    reason: z.literal('linked_to_provider'),
  }),
])

export type DeleteTaskInput = z.infer<typeof deleteTaskInputSchema>
export type DeleteTaskOutput = z.infer<typeof deleteTaskOutputSchema>
