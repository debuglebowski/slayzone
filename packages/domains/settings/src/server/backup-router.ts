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
  restore: publicProcedure
    .input(z.object({ filename: z.string() }))
    .mutation(({ input }) => getBackupOps().restore(input.filename)),
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
