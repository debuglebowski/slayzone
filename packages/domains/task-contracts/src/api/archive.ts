import { z } from 'zod'

export const ArchiveTaskInput = z.object({ id: z.string().uuid() })
export type ArchiveTaskInput = z.infer<typeof ArchiveTaskInput>
