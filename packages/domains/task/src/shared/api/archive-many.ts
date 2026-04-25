import { z } from 'zod'

export const archiveManyInputSchema = z.object({
  ids: z.array(z.string())
})
export type ArchiveManyInput = z.infer<typeof archiveManyInputSchema>

export const archiveManyOutputSchema = z.void()
export type ArchiveManyOutput = z.infer<typeof archiveManyOutputSchema>
