import { typedTrpc } from '@slayzone/transport/client'
// Type-only: erased from the client bundle. The router's runtime stays server-side.
import type { FileEditorMounts } from '@slayzone/file-editor/server'
import type { TaskMounts } from '@slayzone/task/server'

/**
 * This domain's typed view of the shared tRPC client: the same runtime instance as
 * every other view (one context, one socket per hub), typed against only the routers
 * search calls (`fileEditor`, for the palette's file list; `task`, for the hub task
 * search). Domain client code imports
 * `useTRPC` from here, never the whole-app `useTRPC` of `@slayzone/transport/client`.
 */
export const { useTRPC, useTRPCClient } = typedTrpc<FileEditorMounts & TaskMounts>()
