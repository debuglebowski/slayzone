import { z } from 'zod'
import {
  getDiagnosticsConfig,
  saveDiagnosticsConfig,
  recordDiagnosticEvent,
  normalizeClientError,
  normalizeClientEvent,
  buildExportBundle
} from '@slayzone/diagnostics/server'
import type {
  ClientErrorEventInput,
  ClientDiagnosticEventInput,
  DiagnosticsConfig
} from '@slayzone/diagnostics/shared'
import { router, publicProcedure } from '../trpc'

const clientErrorInput = z.unknown() as unknown as z.ZodType<ClientErrorEventInput>
const clientEventInput = z.unknown() as unknown as z.ZodType<ClientDiagnosticEventInput>
const partialConfigInput = z.unknown() as unknown as z.ZodType<Partial<DiagnosticsConfig>>

const exportRequestInput = z.object({
  fromTsMs: z.number().int().nonnegative(),
  toTsMs: z.number().int().nonnegative()
})

// Mirrors the 5 `diagnostics:*` IPC handlers (src/main/service.ts). The store is
// a process-wide singleton bound at boot by registerDiagnosticsHandlers, so these
// procedures and the still-registered IPC handlers share one config cache / one
// event write-queue. IPC stays live this slice; renderer cutover is slice 5.
export const diagnosticsRouter = router({
  getConfig: publicProcedure.query(() => getDiagnosticsConfig()),

  setConfig: publicProcedure
    .input(partialConfigInput)
    .mutation(({ input }) => saveDiagnosticsConfig(input)),

  recordClientError: publicProcedure.input(clientErrorInput).mutation(({ input }) => {
    recordDiagnosticEvent(normalizeClientError(input))
  }),

  recordClientEvent: publicProcedure.input(clientEventInput).mutation(({ input }) => {
    recordDiagnosticEvent(normalizeClientEvent(input))
  }),

  // Returns the export bundle directly to the renderer; the client triggers a
  // browser-native download (createObjectURL + anchor) — the Diagnostics tab is
  // on this path. The legacy IPC `diagnostics:export` handler (save-file dialog)
  // stays registered until the IPC surface drops (slice 8). `platform` defaults
  // to the server host's platform — the renderer has no clean source for it.
  exportBundle: publicProcedure
    .input(exportRequestInput.extend({ appVersion: z.string(), platform: z.string().optional() }))
    .query(({ input }) =>
      buildExportBundle({
        request: { fromTsMs: input.fromTsMs, toTsMs: input.toTsMs },
        appVersion: input.appVersion,
        platform: input.platform ?? process.platform
      })
    )
})
