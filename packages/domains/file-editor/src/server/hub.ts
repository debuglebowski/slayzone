/**
 * `@slayzone/file-editor/hub`: what the HUB uses of this domain — the routers, the
 * deps seams and the refusing no-computer filesystem. Nothing here reads a project
 * folder (lint:server-boundary: the hub bundle must not reach file-ops /
 * repo-discovery). The `./server` barrel keeps the local implementation.
 */
export {
  fileEditorRouter,
  type FileEditorRouter,
  type FileEditorMounts
} from './file-editor-router'
export { workspaceRouter, type WorkspaceRouter, type WorkspaceMounts } from './workspace-router'
export { setWorkspaceDeps, getWorkspaceDeps, type WorkspaceDeps } from './workspace-deps'
export {
  setFileEditorRouterDeps,
  getFileEditorRouterDeps,
  type FileEditorRouterDeps
} from './file-editor-router-deps'
export { noComputerWorkspaceFs, noComputerWorkspaceFsAdapters } from './workspace-fs-none'
export type { LocalWorkspaceFs, WorkspaceFsAdapters } from './workspace-fs'
