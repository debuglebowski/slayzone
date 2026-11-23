/**
 * The app's screens (Expo Router, files in `src/app/`) and how to name them. A row's
 * screen names its hub by address (`host[:port]`, what the user typed at sign-in) and
 * the row's id in that hub, so a deep link — `slayzone://task/<hub>/<task id>` —
 * opens the same row on any device signed in to that hub.
 *
 * Signed in, the app is three tabs (`app/(tabs)/_layout.tsx`), each its own stack:
 *
 *   /                      Board tab (the app opens here): the last project's board
 *   /artifacts             Search tab: search every hub's tasks and artifacts
 *   /settings              Settings tab: hubs (add, sign out, computers), theme, about
 *   /add-hub               sign in to another hub (in the Settings tab)
 *   /new-task?…            create a task (in the Board tab; `task-edit/routes.ts`)
 *
 * Older addresses still open: `/tasks` and `/agents` (the board), `/hubs` (Settings),
 * `/projects` (the board, whose switcher lists the projects).
 *
 * Detail screens push onto the tab they were opened from (the tab bar stays); a deep
 * link opens them in the Board tab, above the board:
 *
 *   /task/<hub>/<id>       a task (`?segment=agent|details|artifacts`: the tab shown;
 *                          its agent is the task's main one — an older link's `&tab=`
 *                          is ignored)
 *   /agent/<hub>/<id>      older link: the task's Agent (its `?tab=` is ignored)
 *   /projects/<hub>/<id>   a project's settings (`projects/routes.ts`)
 *   /artifacts/<hub>/…     a task's artifacts (`artifacts/routes.ts`)
 *
 * Signed out: `/sign-in`, the only screen.
 */
import type { HubSession } from './hub-session'
import { hubEntryOf } from './hub-session'

/** The Board tab, where the app opens. */
export const HOME = '/'
export const SETTINGS = '/settings'
export const ADD_HUB = '/add-hub'

const segment = (value: string): string => encodeURIComponent(value)

/** A task's page; `segment`: the part shown. */
export function taskHref(
  hubAddress: string,
  taskId: string,
  options: { segment?: 'agent' | 'details' | 'artifacts' } = {}
): string {
  const path = `/task/${segment(hubAddress)}/${segment(taskId)}`
  return options.segment ? `${path}?segment=${options.segment}` : path
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

/** The route immediately below this screen, even during the first render of a push. */
export function previousStackRoute(
  stack: { routes: ReadonlyArray<{ key: string; name: string }> } | undefined,
  key: string
): string | undefined {
  if (!stack) return undefined
  const index = stack.routes.findIndex((route) => route.key === key)
  if (index === 0) return undefined
  return stack.routes.at(index === -1 ? -1 : index - 1)?.name
}
