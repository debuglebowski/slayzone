import { useMemo } from 'react'
import { getHubIdForProject, getHubIdForTask, useHubId } from '@slayzone/transport/client'
import type { AmbientTelemetryEvent, TelemetryEventName, TelemetryPropsArgs } from '../shared/types'
import { trackForHub } from './telemetry'

export interface Tracker {
  /** An event that names no task or project: the hub whose UI it happened in. */
  track<E extends AmbientTelemetryEvent>(event: E, ...args: TelemetryPropsArgs<E>): void
  /** An event about task `taskId` (none → as `track`): the hub that owns it. */
  trackTask<E extends TelemetryEventName>(
    taskId: string | null | undefined,
    event: E,
    ...args: TelemetryPropsArgs<E>
  ): void
  /** An event about project `projectId` (none selected → as `track`): the hub that owns it. */
  trackProject<E extends TelemetryEventName>(
    projectId: string | null | undefined,
    event: E,
    ...args: TelemetryPropsArgs<E>
  ): void
  trackShortcut(key: string): void
}

/**
 * Telemetry for UI code: every event belongs to one hub, so a hub with
 * `SLAYZONE_HUB_ENABLE_TELEMETRY=0` withholds exactly the events about its own data
 * (`trackForHub`).
 *
 * Which hub: the task's or project's owner from the ownership map every write consults
 * (`getHubIdForTask` / `getHubIdForProject`) — a board, palette or menu can act on another
 * hub's task from outside that hub's scope — else the hub whose UI it happened in, i.e.
 * the nearest `HubScope` (a task tab's is its task's hub; outside any, the home hub). The
 * same fallback the hub clients use (`useClientForTask`), so an event goes to the hub
 * its write went to.
 */
export function useTrack(): Tracker {
  const hubId = useHubId()
  return useMemo<Tracker>(
    () => ({
      track: (event, ...args) => trackForHub(hubId, event, ...args),
      trackTask: (taskId, event, ...args) =>
        trackForHub(getHubIdForTask(taskId) ?? hubId, event, ...args),
      trackProject: (projectId, event, ...args) =>
        trackForHub(getHubIdForProject(projectId) ?? hubId, event, ...args),
      trackShortcut: (key) => trackForHub(hubId, 'keyboard_shortcut_used', { key })
    }),
    [hubId]
  )
}
