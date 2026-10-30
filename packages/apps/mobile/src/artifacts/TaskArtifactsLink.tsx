/**
 * The way from a task to its artifacts: "Artifacts", with how many the task has (live),
 * opening the task's artifact list. Renders its own hub scope, so it works anywhere under
 * `HubConnections` (the task screen, and the task beside the list on an iPad).
 */
import { HubScope } from '@slayzone/transport/client'
import { useRouter } from 'expo-router'
import { Pressable, StyleSheet, Text } from 'react-native'
import { type ChromeColors, useTheme } from '../theme'
import { taskArtifactsHref } from './routes'
import { useTaskArtifacts } from './use-task-artifacts'

export function TaskArtifactsLink({
  hubId,
  hubAddress,
  taskId
}: {
  hubId: string
  hubAddress: string
  taskId: string
}) {
  return (
    <HubScope hubId={hubId}>
      <Link hubAddress={hubAddress} taskId={taskId} />
    </HubScope>
  )
}

function Link({ hubAddress, taskId }: { hubAddress: string; taskId: string }) {
  const styles = makeStyles(useTheme())
  const router = useRouter()
  const { artifacts } = useTaskArtifacts(taskId)
  return (
    <Pressable
      testID="task-artifacts-link"
      accessibilityRole="button"
      onPress={() => router.push(taskArtifactsHref(hubAddress, taskId))}
      style={styles.link}
    >
      <Text style={styles.label}>Artifacts</Text>
      <Text style={styles.count}>{artifacts ? artifacts.length : ''} ›</Text>
    </Pressable>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    link: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: 8,
      backgroundColor: t.muted
    },
    label: { fontSize: 15, fontWeight: '500', color: t.foreground },
    count: { fontSize: 15, color: t.mutedForeground }
  })
