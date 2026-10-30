/**
 * The app's screens (Expo Router, files in `src/app/`) and how to name them. A row's
 * screen names its hub by address (`host[:port]`, what the user typed at sign-in) and
 * the row's id in that hub, so a deep link — `slayzone://task/<hub>/<task id>` —
 * opens the same row on any device signed in to that hub.
 *
 *   /                      home: every hub's agents and tasks in one list
 *   /task/<hub>/<id>       a task (iPad: beside the list)
 *   /agents                every hub's agents, grouped by what they need
 *   /agent/<hub>/<id>      a task's agents (`?tab=<tab id>`: that tab; else the main one)
 *   /hubs                  the signed-in hubs: add, sign out
 *   /add-hub               sign in to another hub
 *   /sign-in               sign in to the first hub (the only screen while signed out)
 */
import type { HubSession } from './hub-session'
import { hubEntryOf } from './hub-session'

export const HOME = '/'
export const HUBS = '/hubs'
export const ADD_HUB = '/add-hub'
export const AGENTS = '/agents'

const segment = (value: string): string => encodeURIComponent(value)

export function taskHref(hubAddress: string, taskId: string): string {
  return `/task/${segment(hubAddress)}/${segment(taskId)}`
}

/** A task's agents; `tabId`: a tab other than the main one. */
export function agentHref(hubAddress: string, taskId: string, tabId?: string): string {
  const path = `/agent/${segment(hubAddress)}/${segment(taskId)}`
  return tabId ? `${path}?tab=${segment(tabId)}` : path
}

/** The signed-in session of the hub a route names; undefined = not signed in to it. */
export function findSession(
  sessions: readonly HubSession[],
  hubAddress: string | undefined
): HubSession | undefined {
  if (!hubAddress) return undefined
  let id: string
  try {
    id = hubEntryOf(hubAddress).id
  } catch {
    return undefined
  }
  return sessions.find((s) => s.entry.id === id)
}
