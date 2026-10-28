import type { TrpcContext } from '@slayzone/trpc-server'

/**
 * Export/import ops — built per request by `@slayzone/api`, not in the router.
 *
 * The ops read and write `ctx.db` but need api's access scope (O-22: `exportAll`
 * holds only what the caller may access; imported projects belong to the caller),
 * which a domain cannot import. So, like `app.backup`'s `BackupOps`, the router
 * reads a registry here: api registers a factory at load
 * (`api/src/domain-router-deps.ts`) that builds the ops for one request.
 */

export interface ExportResult {
  success: boolean
  canceled?: boolean
  path?: string
  error?: string
}

export interface ImportResult {
  success: boolean
  canceled?: boolean
  projectCount?: number
  taskCount?: number
  importedProjects?: Array<{ id: string; name: string }>
  error?: string
}

// Pure op surface shared by the IPC handlers and the tRPC `app.exportImport`
// router. Test-only ops bypass native dialogs and are present only when `isTest`
// (e2e); the router guards on their presence.
export type ExportImportOps = {
  exportAll: () => Promise<ExportResult>
  exportProject: (projectId: string) => Promise<ExportResult>
  importBundle: () => Promise<ImportResult>
  testExportAllToPath?: (filePath: string) => Promise<ExportResult>
  testExportProjectToPath?: (projectId: string, filePath: string) => Promise<ExportResult>
  testImportFromPath?: (filePath: string) => Promise<ImportResult>
  testSetTaskParent?: (
    taskId: string,
    parentId: string | null
  ) => Promise<{ success: boolean; error?: string }>
}

/** Builds the ops for one request; `isTest` adds the path-taking `test*` variants. */
export type ExportImportOpsFactory = (ctx: TrpcContext, isTest: boolean) => ExportImportOps

let factory: ExportImportOpsFactory | null = null

export function setExportImportOpsFactory(next: ExportImportOpsFactory): void {
  factory = next
}

export function getExportImportOps(ctx: TrpcContext, isTest = false): ExportImportOps {
  if (!factory)
    throw new Error(
      'exportImportOps not initialized — @slayzone/api wires the factory when it composes the router'
    )
  return factory(ctx, isTest)
}
