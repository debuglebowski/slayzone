/**
 * Which tab a link from outside the app opens in (`app/+native-intent.tsx`).
 *
 * The detail screens live in several tabs (`app/(tabs)/(tasks,agents,search)/`): inside
 * the app a push opens the copy in the tab it starts from, but a link has no tab to
 * start from, and Expo Router would pick the first copy whatever the screen. So a link
 * names its tab itself, as group segments (`/(tabs)/(tasks)/task/<hub>/<id>`; the
 * address bar, `usePathname`, never shows them):
 *
 *   task, projects   the Tasks tab, above the tasks list
 *   agent            the Agents tab, above the agents list
 *   artifacts/<hub>  the Search tab, above the search
 *
 * Anything else stays as it is: a tab's own root (`/tasks`, `/artifacts`, `/hubs`,
 * `/add-hub`), a screen outside the tabs (`/sign-in`, `/auth/callback`), a link that
 * already names its tab.
 */

const TAB_OF_FIRST_SEGMENT: Readonly<Record<string, string>> = {
  task: 'tasks',
  projects: 'tasks',
  agent: 'agents'
}

/** `slayzone://task/<hub>/<id>` or `/task/<hub>/<id>` → the path that opens it in its tab. */
export function tabPathOfLink(link: string): string {
  // `slayzone://task/…`: the "host" is the first segment of the path.
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(link)
  const rest = scheme ? link.slice(scheme[0].length) : link
  const queryAt = rest.search(/[?#]/)
  const path = (queryAt === -1 ? rest : rest.slice(0, queryAt)).replace(/^\/+/, '')
  const query = queryAt === -1 ? '' : rest.slice(queryAt)
  const segments = path.split('/')
  const tab =
    TAB_OF_FIRST_SEGMENT[segments[0]] ??
    (segments[0] === 'artifacts' && segments.length > 1 ? 'search' : undefined)
  return tab ? `/(tabs)/(${tab})/${path}${query}` : link
}
