// The `app.backup` router: database backups through the composition root's
// `BackupOps` (`./backup-ops`). `@slayzone/api` mounts it at `app.backup`.
import { z } from 'zod'
import { router, publicProcedure } from '@slayzone/trpc-server'
import { getBackupOps } from './backup-ops'

const anyInput = z.unknown()

// Backup
export const appBackupRouter = router({
  list: publicProcedure.query(() => getBackupOps().list()),
  create: publicProcedure
    .input(z.object({ name: z.string().optional() }).optional())
    .mutation(({ input }) => getBackupOps().create(input?.name)),
  rename: publicProcedure
    .input(z.object({ filename: z.string(), name: z.string() }))
    .mutation(({ input }) => getBackupOps().rename(input.filename, input.name)),
  delete: publicProcedure
    .input(z.object({ filename: z.string() }))
    .mutation(({ input }) => getBackupOps().delete(input.filename)),
  // Stages the restore and returns; the hub then restarts itself to apply it.
  restore: publicProcedure
    .input(z.object({ filename: z.string() }))
    .mutation(({ input }) => getBackupOps().restore(input.filename)),
  restoreStatus: publicProcedure.query(() => getBackupOps().restoreStatus()),
  getSettings: publicProcedure.query(() => getBackupOps().getSettings()),
  setSettings: publicProcedure
    .input(anyInput)
    .mutation(({ input }) =>
      getBackupOps().setSettings(
        input as Partial<Parameters<ReturnType<typeof getBackupOps>['setSettings']>[0]>
      )
    ),
  revealInFinder: publicProcedure.mutation(() => getBackupOps().revealInFinder())
})

export type AppBackupRouter = typeof appBackupRouter
/** Where `@slayzone/api` mounts it: `app.backup`. */
export type AppBackupMounts = { app: { backup: AppBackupRouter } }
