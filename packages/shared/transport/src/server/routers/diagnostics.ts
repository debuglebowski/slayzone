import { z } from 'zod'
import {
  getDiagnosticsConfig,
  saveDiagnosticsConfig,
  recordDiagnosticEvent,
  normalizeClientError,
  normalizeClientEvent,
  buildExportBundle,
} from '@slayzone/diagnostics/server'
import type {
  ClientErrorEventInput,
  ClientDiagnosticEventInput,
  DiagnosticsConfig,
} from '@slayzone/diagnostics/shared'
import { router, publicProcedure } from '../trpc'

const clientErrorInput = z.unknown() as unknown as z.ZodType<ClientErrorEventInput>
const clientEventInput = z.unknown() as unknown as z.ZodType<ClientDiagnosticEventInput>
const partialConfigInput = z.unknown() as unknown as z.ZodType<Partial<DiagnosticsConfig>>

const exportRequestInput = z.object({
  fromTsMs: z.number().int().nonnegative(),
  toTsMs: z.number().int().nonnegative(),
})

export const diagnosticsRouter = router({
  getConfig: publicProcedure.query(() => getDiagnosticsConfig()),

  setConfig: publicProcedure
    .input(partialConfigInput)
    .mutation(({ input }) => saveDiagnosticsConfig(input)),

  recordClientError: publicProcedure
    .input(clientErrorInput)
    .mutation(({ input }) => {
      recordDiagnosticEvent(normalizeClientError(input))
    }),

  recordClientEvent: publicProcedure
    .input(clientEventInput)
    .mutation(({ input }) => {
      recordDiagnosticEvent(normalizeClientEvent(input))
    }),

  // Returns the export bundle directly to the renderer; the client triggers a
  // browser-native download (createObjectURL + anchor). The previous IPC
  // handler used Electron's save-file dialog — that UX coupling is intentionally
  // dropped during transport migration. If a path picker becomes a hard
  // requirement, add it back in a follow-up via `window.api.dialog`.
  exportBundle: publicProcedure
    .input(exportRequestInput.extend({ appVersion: z.string(), platform: z.string() }))
    .query(({ input }) =>
      buildExportBundle({
        request: { fromTsMs: input.fromTsMs, toTsMs: input.toTsMs },
        appVersion: input.appVersion,
        platform: input.platform,
      }),
    ),
})
