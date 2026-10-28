import { z } from 'zod'
import {
  getDiagnosticsConfig,
  saveDiagnosticsConfig,
  recordDiagnosticEvent,
  normalizeClientError,
  normalizeClientEvent,
  buildExportBundle,
  summarizeExportEvents
} from './diagnostics-store'
import type {
  ClientErrorEventInput,
  ClientDiagnosticEventInput,
  DiagnosticsConfig,
  DiagnosticsExportBundle
} from '../shared'
import { router, publicProcedure } from '@slayzone/trpc-server'
import {
  getDiagnosticsRouterDeps,
  type DiagnosticsAccessScope,
  type DiagnosticsNamedResource
} from './diagnostics-router-deps'

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
    .query(async ({ ctx, input }) => {
      const bundle = await buildExportBundle({
        request: { fromTsMs: input.fromTsMs, toTsMs: input.toTsMs },
        appVersion: input.appVersion,
        platform: input.platform ?? process.platform
      })
      // On a hub with login only an admin gets here (T-15), and an admin must not
      // read other users' terminals (O-4): drop captured pty output whatever
      // `includePtyOutput` was when it was recorded — and every event about another
      // user's task, session or project (O-6, T-101). No principal (the desktop app's
      // own hub) keeps the bundle exactly as recorded.
      if (!ctx.principal) return bundle
      return withoutOthersEvents(
        withoutPtyOutput(bundle),
        getDiagnosticsRouterDeps().accessScopeFor(ctx)
      )
    })
})

/** The bundle with every `pty.data` event's captured bytes replaced by their length. */
export function withoutPtyOutput(
  bundle: DiagnosticsExportBundle | null
): DiagnosticsExportBundle | null {
  if (!bundle) return bundle
  return {
    ...bundle,
    events: bundle.events.map((e) => {
      const payload = e.payload as { data?: unknown; length?: unknown } | null
      if (e.event !== 'pty.data' || !payload || payload.data === undefined) return e
      return { ...e, payload: { length: payload.length ?? null, included: false } }
    }),
    redaction: { ...bundle.redaction, includePtyOutput: false }
  }
}

/**
 * The bundle without the events that name a task, agent session or project the caller
 * may not access (`canAccess`), its summary recounted from what is left. An event that
 * names none of them is the hub's own (boot, sockets, the database) and stays. A scope
 * that does not enforce (no login) returns the bundle as it is.
 */
export async function withoutOthersEvents(
  bundle: DiagnosticsExportBundle | null,
  scope: DiagnosticsAccessScope
): Promise<DiagnosticsExportBundle | null> {
  if (!bundle || !scope.enforcing) return bundle
  const events: DiagnosticsExportBundle['events'] = []
  for (const e of bundle.events) {
    const named: DiagnosticsNamedResource[] = []
    if (e.taskId) named.push({ kind: 'task', id: e.taskId })
    if (e.sessionId) named.push({ kind: 'session', id: e.sessionId })
    if (e.projectId) named.push({ kind: 'project', id: e.projectId })
    if (await scope.allowsAll(named)) events.push(e)
  }
  return { ...bundle, events, summary: summarizeExportEvents(events) }
}

export type DiagnosticsRouter = typeof diagnosticsRouter
/** Where api mounts this domain's router (`router.ts`). */
export type DiagnosticsMounts = { diagnostics: DiagnosticsRouter }
