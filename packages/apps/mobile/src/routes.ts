/**
 * The app's screens (Expo Router, files in `src/app/`) and how to name them. A row's
 * screen names its hub by address (`host[:port]`, what the user typed at sign-in) and
 * the row's id in that hub, so a deep link — `slayzone://task/<hub>/<task id>` —
 * opens the same row on any device signed in to that hub.
 *
 * Signed in, the app is four tabs (`app/(tabs)/_layout.tsx`), each its own stack:
 *
 *   /                      Agents tab (the app opens here): every hub's agents, grouped
 *                          by what they need (`/agents`: the same, for older links)
 *   /tasks                 Tasks tab: every hub's tasks (iPad: `?hub=&task=` beside the list)
 *   /artifacts             Search tab: search every hub's artifacts
 *   /hubs                  Hubs tab: the signed-in hubs: add, sign out
 *   /add-hub               sign in to another hub (in the Hubs tab)
 *
 * Detail screens push onto the tab they were opened from (the tab bar stays); a deep
 * link opens them in the Tasks tab, above its list:
 *
 *   /task/<hub>/<id>       a task (iPad: beside the list)
 *   /agent/<hub>/<id>      a task's agents (`?tab=<tab id>`: that tab; else the main one)
 *   /projects …            projects (`projects/routes.ts`)
 *   /artifacts/<hub>/…     a task's artifacts (`artifacts/routes.ts`)
 *
 * Signed out: `/sign-in`, the only screen.
 */
import type { HubSession } from './hub-session'
import { hubEntryOf } from './hub-session'

/** The Agents tab, where the app opens. */
export const AGENTS = '/'
/** Where the app opens: the Agents tab. */
export const HOME = AGENTS
export const TASKS = '/tasks'
export const HUBS = '/hubs'
export const ADD_HUB = '/add-hub'

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
