import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Project } from '@slayzone/projects-contracts'
import { useAuthFailedConnections } from '../useAuthFailedConnections'
import type { ProjectSettingsTab } from './constants'

type AuthFailures = ReturnType<typeof useAuthFailedConnections>['failed']

export interface AuthFailureBannerApi {
  visibleAuthFailures: AuthFailures
  reconnectAuthFailure: () => void
  dismissAuthFailures: () => void
}

// Integration auth-expiry banner: tracks failed connections, filters to the
// selected project, and dismiss/reconnect actions. Refetches when the Settings
// view (where a reconnect happens, on the project's Integrations tab) closes.
export function useAuthFailureBanner(
  settingsOpen: boolean,
  selectedProjectId: string,
  projects: Project[],
  openProjectSettings: (project: Project, options?: { initialTab?: ProjectSettingsTab }) => void
): AuthFailureBannerApi {
  const { failed: authFailedConnections, refetch: refetchAuthFailures } = useAuthFailedConnections()
  useEffect(() => {
    if (!settingsOpen) refetchAuthFailures()
  }, [settingsOpen, refetchAuthFailures])
  const [dismissedAuthFailureIds, setDismissedAuthFailureIds] = useState<Set<string>>(new Set())
  const visibleAuthFailures = useMemo(
    () =>
      authFailedConnections.filter(
        (f) =>
          !dismissedAuthFailureIds.has(f.connection.id) &&
          selectedProjectId !== null &&
          f.projectIds.includes(selectedProjectId)
      ),
    [authFailedConnections, dismissedAuthFailureIds, selectedProjectId]
  )
  const reconnectAuthFailure = useCallback(() => {
    if (!selectedProjectId) return
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    openProjectSettings(project, { initialTab: 'integrations' })
  }, [selectedProjectId, projects, openProjectSettings])
  const dismissAuthFailures = useCallback(() => {
    setDismissedAuthFailureIds(
      (prev) => new Set([...prev, ...visibleAuthFailures.map((f) => f.connection.id)])
    )
  }, [visibleAuthFailures])

  return { visibleAuthFailures, reconnectAuthFailure, dismissAuthFailures }
}
