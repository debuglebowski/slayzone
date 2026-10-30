/**
 * A task's description: rendered (the chat's native `Markdown`: it sizes to its text
 * inside the task's scrolling screen, takes the theme, draws task lists, code and
 * tables; its `artifact:` links open the artifact viewer), and edited as the raw
 * markdown desktop wrote, in a sheet (`DescriptionEditor`). Scopes itself to the task's
 * hub.
 */
import { HubScope } from '@slayzone/transport/client'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Text } from 'react-native'
import { artifactHref } from '../artifacts/routes'
import { Markdown } from '../chat/Markdown'
import type { TaskRow } from '../hub-board'
import { useTheme } from '../theme'
import { artifactIdOf, editableDescription } from './description'
import { DescriptionEditor } from './DescriptionEditor'
import { makeStyles, Section } from './ui'

export function DescriptionSection({ row }: { row: TaskRow }) {
  return (
    <HubScope hubId={row.hubId}>
      <Description row={row} />
    </HubScope>
  )
}

function Description({ row }: { row: TaskRow }) {
  const styles = makeStyles(useTheme())
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const text = editableDescription(row.task)
  const onLink = (href: string): boolean => {
    const artifactId = artifactIdOf(href)
    if (!artifactId) return false
    router.push(artifactHref(row.hubLabel, row.task.id, artifactId))
    return true
  }
  return (
    <Section title="Description" action={{ label: 'Edit', onPress: () => setEditing(true) }}>
      {text.trim() ? (
        <Markdown text={text} onLink={onLink} />
      ) : (
        <Text style={styles.muted}>No description</Text>
      )}
      {editing ? <DescriptionEditor row={row} onClose={() => setEditing(false)} /> : null}
    </Section>
  )
}
