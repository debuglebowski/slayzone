/**
 * The artifact routes, wired to the app (sessions, feeds, navigation); `src/app/artifacts/`
 * only reads the route's params into these.
 *
 * A task's artifacts and one artifact render inside the hub scope of the hub the route
 * names, so everything they read or write goes to the hub that owns them. Phone: the list
 * and the artifact are two screens (a tap pushes the artifact). Wide screen (an iPad,
 * `useWide`; never an iPhone, landscape included): one screen, list and artifact side by
 * side; picking another artifact or version replaces the route, so the URL always names
 * what is shown and Back leaves the artifacts. Both are one `ArtifactsScreen`, so an iPad
 * changing width (rotation, Split View) keeps the open artifact as it is.
 */
import { HubScope } from '@slayzone/transport/client'
import { useNavigation, useRoute, useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { HubSession } from '../hub-session'
import { useHubSessions } from '../hub-sessions'
import { useWide } from '../layout'
import { findSession, HOME } from '../routes'
import { type ChromeColors, useTheme } from '../theme'
import { useTRPCClient } from '../trpc'
import { ArtifactsScreen } from './ArtifactsScreen'
import { artifactHref, taskArtifactsHref } from './routes'
import { ScreenHeader } from './ScreenHeader'

/** `/artifacts/<hub>/<task>` (`artifactId` null) and `/artifacts/<hub>/<task>/<id>[?version=]`. */
export function TaskArtifactsRoute({
  hub,
  taskId,
  artifactId,
  version
}: {
  hub: string
  taskId: string
  artifactId: string | null
  version: number | null
}) {
  const router = useRouter()
  const { sessions = [] } = useHubSessions()
  const session = findSession(sessions, hub)
  const back = () => (router.canGoBack() ? router.back() : router.replace(HOME))
  if (!session) return <NotSignedIn hub={hub} onBack={back} />
  return (
    <HubScope hubId={session.entry.id}>
      <InHubScope
        session={session}
        hub={hub}
        taskId={taskId}
        artifactId={artifactId}
        version={version}
      />
    </HubScope>
  )
}

/**
 * What Back on an artifact says: the screen below it in the stack (by its route name),
 * else — opened by a link, nothing below — the task's artifacts, where Back then goes.
 */
export function artifactBackLabel(previousRoute: string | undefined): string {
  if (previousRoute === undefined) return 'Artifacts'
  if (previousRoute.startsWith('artifacts/[hub]/[task]/index')) return 'Artifacts'
  if (previousRoute.startsWith('artifacts/[hub]/[task]/[id]')) return 'Back'
  if (previousRoute === 'artifacts/index') return 'Search'
  if (previousRoute.startsWith('task/')) return 'Task'
  if (previousRoute.startsWith('agent/')) return 'Agent'
  if (previousRoute.startsWith('projects/')) return 'Project'
  if (previousRoute === 'index') return 'Board'
  return 'Back'
}

/**
 * The name of the route under `key` in its stack. On the first render of a screen just
 * pushed, the stack may not list it yet: the screen on top then is the one below it.
 */
function routeBelow(
  stack: { routes: ReadonlyArray<{ key: string; name: string }> } | undefined,
  key: string
): string | undefined {
  if (!stack) return undefined
  const at = stack.routes.findIndex((r) => r.key === key)
  if (at === -1) return stack.routes[stack.routes.length - 1]?.name
  return at > 0 ? stack.routes[at - 1].name : undefined
}

function InHubScope({
  session,
  hub,
  taskId,
  artifactId,
  version
}: {
  session: HubSession
  hub: string
  taskId: string
  artifactId: string | null
  version: number | null
}) {
  const router = useRouter()
  const navigation = useNavigation()
  const hubClient = useTRPCClient()
  const styles = makeStyles(useTheme())
  const [linkError, setLinkError] = useState<string | null>(null)
  const wide = useWide()
  const layout = wide ? 'split' : artifactId !== null ? 'artifact' : 'list'
  const back = () => (router.canGoBack() ? router.back() : router.replace(HOME))
  const routeKey = useRoute().key
  const previousRoute = routeBelow(navigation.getState(), routeKey)

  // An artifact link names an artifact, not its task: ask its hub which task holds it.
  const openLinked = (id: string) => {
    setLinkError(null)
    hubClient.artifacts.get
      .query({ id })
      .then((row) => {
        if (!row) {
          setLinkError('The linked artifact no longer exists.')
          return
        }
        const href = artifactHref(hub, row.task_id, row.id)
        if (wide) router.replace(href)
        else router.push(href)
      })
      .catch((err: unknown) => setLinkError(err instanceof Error ? err.message : String(err)))
  }

  const selectVersion = (id: string, v: number | null) => {
    const href = artifactHref(hub, taskId, id, v === null ? {} : { version: v })
    if (wide) router.replace(href)
    else if (layout === 'artifact')
      router.setParams({ version: v === null ? undefined : String(v) })
    else router.push(href)
  }

  return (
    <View style={styles.fill}>
      {linkError ? <Text style={styles.error}>{linkError}</Text> : null}
      <ArtifactsScreen
        session={session}
        taskId={taskId}
        layout={layout}
        selected={artifactId ? { artifactId, version } : null}
        onSelect={(id) =>
          wide
            ? router.replace(artifactHref(hub, taskId, id))
            : router.push(artifactHref(hub, taskId, id))
        }
        onSelectVersion={selectVersion}
        onOpenArtifact={openLinked}
        onBack={back}
        onCloseArtifact={() =>
          router.canGoBack() ? router.back() : router.replace(taskArtifactsHref(hub, taskId))
        }
        artifactBackLabel={artifactBackLabel(previousRoute)}
      />
    </View>
  )
}

function NotSignedIn({ hub, onBack }: { hub: string; onBack: () => void }) {
  const styles = makeStyles(useTheme())
  return (
    <View style={styles.fill}>
      <ScreenHeader title="Artifacts" onBack={onBack} />
      <Text style={styles.note}>Not signed in to {hub}</Text>
    </View>
  )
}

/** A route param as a version number; anything else = none. */
export function versionParam(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw || !/^\d+$/.test(raw)) return null
  return Number(raw)
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: t.background },
    note: { color: t.mutedForeground, padding: 24, textAlign: 'center' },
    error: { color: t.destructive, paddingHorizontal: 16, paddingVertical: 8, fontSize: 13 }
  })
