import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { TRPCError } from '@trpc/server'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import {
  activeUploadCount,
  appendChunk,
  archivePath,
  commitMigration,
  discardUpload,
  getHealth,
  getUploadDir,
  migrateEvents,
  preflight,
  pruneStale,
  readManifest,
  runLocalExport,
  unpackArchive,
  unpackedDir,
  verifyArchive,
  verifyManifestAgainstUnpacked,
  type RemoteClient,
} from '@slayzone/migrate/server'
import {
  DEFAULT_MAX_ARCHIVE_BYTES,
  DEFAULT_MAX_CHUNK_BYTES,
  type Manifest,
  type MigrateReceipt,
  type ProgressEvent,
} from '@slayzone/migrate/shared'
import { router, publicProcedure } from '../trpc'
import type { AppRouter } from '../router'

const manifestSchema = z.unknown() as unknown as z.ZodType<Manifest>

function emit(uploadId: string, phase: ProgressEvent['phase'], percent: number, message: string): void {
  migrateEvents.emit('progress', { uploadId, phase, percent, message })
}

export const migrateRouter = router({
  health: publicProcedure.query(({ ctx }) => {
    return getHealth(ctx.db, ctx.slayzoneVersion ?? '0.0.0')
  }),

  preflight: publicProcedure.mutation(({ ctx }) => {
    pruneStale()
    if (activeUploadCount() > 0) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Another migration upload is already in progress',
      })
    }
    return preflight({ dataRoot: ctx.dataRoot })
  }),

  uploadAppend: publicProcedure
    .input(
      z.object({
        uploadId: z.string().uuid(),
        seq: z.number().int().nonnegative(),
        data: z.string(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await appendChunk(input, DEFAULT_MAX_ARCHIVE_BYTES)
        emit(input.uploadId, 'uploading', 0, `chunk ${input.seq} accepted`)
      } catch (err) {
        discardUpload(input.uploadId)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }),

  uploadFinalize: publicProcedure
    .input(
      z.object({
        uploadId: z.string().uuid(),
        manifest: manifestSchema,
        archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
        archiveBytes: z.number().int().positive(),
        dryRun: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { uploadId, manifest, archiveSha256, archiveBytes, dryRun } = input
      try {
        emit(uploadId, 'verifying-archive', 0, 'verifying archive sha256')
        await verifyArchive(uploadId, archiveSha256, archiveBytes)

        emit(uploadId, 'unpacking', 0, 'unpacking archive')
        const dest = unpackedDir(ctx.dataRoot, uploadId)
        await unpackArchive(archivePath(ctx.dataRoot, uploadId), dest)

        emit(uploadId, 'verifying-manifest', 0, 'verifying file checksums')
        const onDisk = await readManifest(dest)
        if (onDisk.protocolVersion !== manifest.protocolVersion) {
          throw new Error(
            `Protocol version mismatch: manifest=${onDisk.protocolVersion} vs declared=${manifest.protocolVersion}`,
          )
        }
        const verify = await verifyManifestAgainstUnpacked(dest, onDisk)
        if (!verify.ok) {
          const detail = [
            verify.missing.length ? `missing=${verify.missing.length}` : '',
            verify.mismatched.length ? `mismatched=${verify.mismatched.length}` : '',
            verify.extra.length ? `extra=${verify.extra.length}` : '',
          ]
            .filter(Boolean)
            .join(', ')
          throw new Error(`Archive integrity failure: ${detail}`)
        }

        emit(uploadId, 'committing', 0, dryRun ? 'dry-run import' : 'committing')
        const result = commitMigration({
          db: ctx.db,
          dataRoot: ctx.dataRoot,
          unpackedDir: dest,
          manifest: onDisk,
          dryRun,
        })

        if (!result.ok) {
          throw new Error(result.errors.join('; ') || 'commit failed')
        }

        // Patch file presence with shared verification result.
        const receipt: MigrateReceipt = {
          ok: result.ok,
          dryRun: result.dryRun,
          files: {
            expected: onDisk.files.length,
            present: onDisk.files.length - verify.missing.length,
            mismatched: [...verify.mismatched, ...verify.extra],
          },
          tables: result.tables,
          worktreeRowsRewritten: result.worktreeRowsRewritten,
          durationMs: result.durationMs,
          errors: result.errors,
        }

        emit(uploadId, 'cleaning-up', 0, 'cleaning up temp')
        discardUpload(uploadId)
        emit(uploadId, 'done', 1, dryRun ? 'dry-run complete' : 'migration complete')

        return receipt
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        emit(uploadId, 'error', 0, message)
        discardUpload(uploadId)
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message })
      }
    }),

  cancel: publicProcedure
    .input(z.object({ uploadId: z.string().uuid() }))
    .mutation(({ input }) => {
      discardUpload(input.uploadId)
    }),

  progress: publicProcedure
    .input(z.object({ uploadId: z.string().uuid().optional() }).optional())
    .subscription(({ input }) =>
      observable<ProgressEvent>((emitObs) => {
        const filterId = input?.uploadId
        const handler = (ev: ProgressEvent): void => {
          if (!filterId || ev.uploadId === filterId) emitObs.next(ev)
        }
        migrateEvents.on('progress', handler)
        return () => {
          migrateEvents.off('progress', handler)
        }
      }),
    ),

  /** Surfaced for client-side UI hints. Returns server-side caps & active upload count. */
  status: publicProcedure.query(() => ({
    activeUploads: activeUploadCount(),
    maxChunkBytes: DEFAULT_MAX_CHUNK_BYTES,
    maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES,
  })),

  /** Source-side orchestrator: pack + upload + finalize against remoteUrl.
   *  Runs in the local embedded server's process (= Electron main). Renderer
   *  observes via the local `migrate.progress` subscription. */
  localExport: publicProcedure
    .input(
      z.object({
        remoteUrl: z.string().url(),
        dryRun: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<MigrateReceipt> => {
      const remote = await connectRemote(input.remoteUrl)
      try {
        return await runLocalExport({
          db: ctx.db,
          dataRoot: ctx.dataRoot,
          slayzoneVersion: ctx.slayzoneVersion ?? '0.0.0',
          remote: remote.client,
          dryRun: input.dryRun,
        })
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        })
      } finally {
        remote.close()
      }
    }),
})

interface RemoteHandle {
  client: RemoteClient
  close: () => void
}

async function connectRemote(url: string): Promise<RemoteHandle> {
  const wsClient = createWSClient({ url })
  const trpc = createTRPCClient<AppRouter>({
    links: [wsLink({ client: wsClient, transformer: superjson })],
  })
  const client: RemoteClient = {
    health: () => trpc.migrate.health.query(),
    preflight: () => trpc.migrate.preflight.mutate(),
    uploadAppend: (input) => trpc.migrate.uploadAppend.mutate(input),
    uploadFinalize: (input) => trpc.migrate.uploadFinalize.mutate(input),
    cancel: (input) => trpc.migrate.cancel.mutate(input),
  }
  return {
    client,
    close: () => {
      try { wsClient.close() } catch { /* ignore */ }
    },
  }
}

void getUploadDir
