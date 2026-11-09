import type { AdminContentErasure } from './admin'

export interface HubAdminDeps {
  dataRoot: string
  users: {
    ready: () => boolean
    list: () => Promise<
      Array<{ id: string; email: string; name: string; disabledAt: string | null }>
    >
    disable: (
      email: string
    ) => Promise<'ok' | 'not-found' | 'protected' | 'last-user' | 'last-admin'>
  }
  erasure: AdminContentErasure
}
let current: HubAdminDeps | null = null
export function setHubAdminDeps(deps: HubAdminDeps | null): void {
  current = deps
}
export function getHubAdminDeps(): HubAdminDeps | null {
  return current
}
