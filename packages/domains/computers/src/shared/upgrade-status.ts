import { z } from 'zod'
export const computerUpgradeStatusSchema = z
  .object({
    phase: z.enum([
      'checking',
      'installing',
      'waiting-for-idle',
      'restarting',
      'probation',
      'connected',
      'rollback',
      'failed',
      'maintenance-required'
    ]),
    currentVersion: z.string().max(100),
    hostVersion: z.string().max(100),
    version: z.string().max(100).optional(),
    target: z.string().max(100).optional(),
    error: z.string().max(2048).optional(),
    retryAt: z.number().nonnegative().optional(),
    maintenanceReason: z.string().max(256).optional(),
    updatedAt: z.string().max(64)
  })
  .strict()
export type ComputerUpgradeStatus = z.infer<typeof computerUpgradeStatusSchema>
