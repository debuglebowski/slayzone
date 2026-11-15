import { useCallback } from 'react'
import { useHubId } from '@slayzone/transport/client'
import { toSlzFileUrl, toSlzSourceUrl } from '@slayzone/platform/slz-file-url'
import { useWorkspaceTarget } from './workspace-target'

/**
 * Preview URL for a file of this panel's workspace (images, PDFs, markdown images).
 *
 * The workspace may live on another machine — a remote hub's computer — so the
 * URL names the hub and the panel's target rather than a path on this disk; the
 * desktop fetches it from that hub, which routes the read to the computer the
 * editor's other calls go to. Outside any hub scope, or with no task or project
 * to scope the read (tests, standalone viewers), it falls back to a plain local path.
 *
 * `relPath` is relative to `rootPath`, `/`-separated.
 */
export function useWorkspaceFileUrl(
  rootPath: string
): (relPath: string, version?: string | number) => string {
  const hubId = useHubId()
  const { computerId, taskId, projectId } = useWorkspaceTarget()
  return useCallback(
    (relPath: string, version?: string | number) => {
      // The hub reads a workspace only within a task's or project's path scope.
      if (!hubId || (!taskId && !projectId))
        return toSlzFileUrl(`${rootPath.replace(/\/+$/, '')}/${relPath}`, version)
      return toSlzSourceUrl(
        {
          kind: 'workspace',
          hubId,
          rootPath,
          ...(computerId !== undefined ? { computerId } : {}),
          ...(taskId ? { taskId } : {}),
          ...(projectId ? { projectId } : {})
        },
        relPath,
        version
      )
    },
    [hubId, rootPath, computerId, taskId, projectId]
  )
}

/** `abs` relative to `root` (`/`-separated), or null when it lies outside it. */
export function relativeToRoot(root: string, abs: string): string | null {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return abs.startsWith(prefix) && abs.length > prefix.length ? abs.slice(prefix.length) : null
}
