import { shell } from 'electron'
import {
  inferHostScopeFromUrl,
  inferProtocolFromUrl,
  isEncodedDesktopHandoffUrl,
  isLoopbackHost,
  isLoopbackUrl,
  normalizeDesktopHostScope,
  normalizeDesktopProtocol,
  type DesktopHandoffPolicy
} from '@slayzone/task/shared'

// Pure shell ops shared by the IPC handlers (shell:open-external / shell:open-path)
// and the tRPC `app.shell` router (via setAppDeps). Both transports delegate here
// (coexistence until the renderer drops IPC in slice 5).

// Open an external URL, restricted to safe schemes, with desktop-handoff guarding
// (blocks `intent://`-style app-handoff URLs when a policy is in force).
export function shellOpenExternal(
  url: string,
  options?: {
    blockDesktopHandoff?: boolean
    desktopHandoff?: DesktopHandoffPolicy
  }
): void {
  if (!/^https?:\/\//i.test(url) && !url.startsWith('mailto:')) {
    throw new Error('Only http, https, and mailto URLs are allowed')
  }
  const desktopHandoffPolicy =
    options?.desktopHandoff ??
    (() => {
      if (!options?.blockDesktopHandoff) return null
      const protocol = normalizeDesktopProtocol(inferProtocolFromUrl(url))
      if (!protocol) return null
      const hostScope = normalizeDesktopHostScope(inferHostScopeFromUrl(url))
      return hostScope ? { protocol, hostScope } : { protocol }
    })()
  const shouldBlockLoopbackDesktopHandoff =
    desktopHandoffPolicy !== null &&
    isLoopbackUrl(url) &&
    !isLoopbackHost(normalizeDesktopHostScope(desktopHandoffPolicy.hostScope))
  if (
    desktopHandoffPolicy &&
    (isEncodedDesktopHandoffUrl(url, desktopHandoffPolicy) || shouldBlockLoopbackDesktopHandoff)
  ) {
    throw new Error('Blocked external app handoff URL')
  }
  shell.openExternal(url)
}

export function shellOpenPath(absPath: string): Promise<string> {
  if (typeof absPath !== 'string' || !absPath.startsWith('/')) {
    throw new Error('absolute path required')
  }
  return shell.openPath(absPath)
}
