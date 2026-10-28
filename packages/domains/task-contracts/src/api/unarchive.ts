import { z } from 'zod'

export const unarchiveInputSchema = z.object({
  id: z.string().uuid()
})

export type UnarchiveInput = z.infer<typeof unarchiveInputSchema>
