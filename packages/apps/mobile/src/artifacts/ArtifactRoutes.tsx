/**
 * The artifact routes, wired to the app (sessions, feeds, navigation); `src/app/artifacts/`
 * only reads the route's params into these.
 *
 * A task's artifacts and one artifact render inside the hub scope of the hub the route
 * names, so everything they read or write goes to the hub that owns them. Phone: the list
 * and the artifact are two screens (a tap pushes the artifact). Wide screen (iPad): one
 * screen, list and artifact side by side; picking another artifact or version replaces
 * the route, so the URL always names what is shown and Back leaves the artifacts.
 */
import { HubScope } from '@slayzone/transport/client'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useHubFeeds } from '../hub-connections'
import type { HubSession } from '../hub-session'
import { useHubSessions } from '../hub-sessions'
import { findSession, HOME } from '../routes'
import { SPLIT_MIN_WIDTH } from '../TaskBrowser'
import { type ChromeColors, useTheme } from '../theme'
import { useTRPCClient } from '../trpc'
import { ArtifactSearchScreen } from './ArtifactSearchScreen'
import { ArtifactsScreen } from './ArtifactsScreen'
import { ArtifactViewer } from './ArtifactViewer'
import { hubTarget } from './hub-rest'
import { artifactHref, taskArtifactsHref } from './routes'
import { ScreenHeader } from './ScreenHeader'

/** `/artifacts`: search every hub. */
export function ArtifactSearchRoute() {
  const router = useRouter()
  const { sessions = [] } = useHubSessions()
  const { feeds } = useHubFeeds()
  return (
    <ArtifactSearchScreen
      sessions={sessions}
      feeds={feeds}
      onOpen={(r) => router.push(artifactHref(r.hubLabel, r.taskId, r.artifactId))}
      onBack={() => (router.canGoBack() ? router.back() : router.replace(HOME))}
    />
  )
}

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
        isViewerRoute={artifactId !== null}
      />
    </HubScope>
  )
}

function InHubScope({
  session,
  hub,
  taskId,
  artifactId,
  version,
  isViewerRoute
}: {
  session: HubSession
  hub: string
  taskId: string
  artifactId: string | null
  version: number | null
  isViewerRoute: boolean
}) {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const hubClient = useTRPCClient()
  const styles = makeStyles(useTheme())
  const [linkError, setLinkError] = useState<string | null>(null)
  const split = width >= SPLIT_MIN_WIDTH
  const back = () => (router.canGoBack() ? router.back() : router.replace(HOME))

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
        if (split) router.replace(href)
        else router.push(href)
      })
      .catch((err: unknown) => setLinkError(err instanceof Error ? err.message : String(err)))
  }

  const error = linkError ? <Text style={styles.error}>{linkError}</Text> : null

  if (split) {
    return (
      <View style={styles.fill}>
        {error}
        <ArtifactsScreen
          session={session}
          taskId={taskId}
          layout="split"
          selected={artifactId ? { artifactId, version } : null}
          onSelect={(id) => router.replace(artifactHref(hub, taskId, id))}
          onSelectVersion={(id, v) =>
            router.replace(artifactHref(hub, taskId, id, v === null ? {} : { version: v }))
          }
          onBack={back}
        />
      </View>
    )
  }

  if (isViewerRoute && artifactId) {
    return (
      <View style={styles.fill}>
        {error}
        <ArtifactViewer
          target={hubTarget(session)}
          taskId={taskId}
          artifactId={artifactId}
          version={version}
          onSelectVersion={(v) => router.setParams({ version: v === null ? undefined : String(v) })}
          onOpenArtifact={openLinked}
          onBack={() =>
            router.canGoBack() ? router.back() : router.replace(taskArtifactsHref(hub, taskId))
          }
        />
      </View>
    )
  }

  return (
    <ArtifactsScreen
      session={session}
      taskId={taskId}
      layout="list"
      selected={null}
      onSelect={(id) => router.push(artifactHref(hub, taskId, id))}
      onSelectVersion={(id, v) =>
        router.push(artifactHref(hub, taskId, id, v === null ? {} : { version: v }))
      }
      onBack={back}
    />
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
