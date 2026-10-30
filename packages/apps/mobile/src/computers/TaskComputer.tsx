import {
  computerName,
  inheritComputerLabel,
  NO_COMPUTERS_NOTE,
  runsOnLabel
} from '@slayzone/computers/labels'
import { workComputerId } from '@slayzone/projects-contracts/placements'
import { HubScope } from '@slayzone/transport/client'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import type { TaskRow } from '../hub-board'
import { type ChromeColors, useTheme } from '../theme'
import { useTRPC } from '../trpc'
import { type Choice, ChoiceSheet } from './ChoiceSheet'
import { choiceLabel } from './hub-computers'
import { useHubComputers } from './use-hub-computers'

/** The choice key of "follow the project" (the task's binding null). */
const INHERIT = '__inherit__'

/**
 * Which computer runs a task's agents, and changing it — desktop's Computer card: the
 * task follows its project's computer or is pinned to one (`computers.setTaskComputer`,
 * null = follow), offline computers are marked but offered (work waits for them), no
 * confirmation. A change applies to the agent's NEXT start (`task.startMainAgent`); an
 * agent already running stays where it is, as on desktop.
 *
 * Scopes itself to the hub that owns the task: the write goes to that hub, whatever
 * screen shows the card.
 */
export function TaskComputer({ row }: { row: TaskRow }) {
  return (
    <HubScope hubId={row.hubId}>
      <TaskComputerCard row={row} />
    </HubScope>
  )
}

function TaskComputerCard({ row }: { row: TaskRow }) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const trpc = useTRPC()
  const { computers, pending, error: listError } = useHubComputers()
  const { mutateAsync: setTaskComputer } = useMutation(
    trpc.computers.setTaskComputer.mutationOptions()
  )
  const saved = row.task.computer_id ?? null
  const [sheetOpen, setSheetOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The choice shown at once, before the hub's board reload confirms it; re-synced
  // (during render, not in an effect) when the saved binding or the task changes.
  const [binding, setBinding] = useState<string | null>(saved)
  const [syncedFrom, setSyncedFrom] = useState({ taskId: row.task.id, saved })
  if (syncedFrom.taskId !== row.task.id || syncedFrom.saved !== saved) {
    setSyncedFrom({ taskId: row.task.id, saved })
    setBinding(saved)
  }

  const choose = (key: string): void => {
    const computerId = key === INHERIT ? null : key
    if (computerId === binding) return
    setBinding(computerId)
    setError(null)
    setTaskComputer({ taskId: row.task.id, computerId }).catch((err: unknown) => {
      // Not saved: the hub still holds the old binding, show it again.
      setBinding(saved)
      setError(`Couldn't change the computer: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  let body
  if (pending) body = <ActivityIndicator color={theme.mutedForeground} />
  else if (listError) body = <Text style={styles.error}>{listError}</Text>
  else if (computers.length === 0) body = <Text style={styles.note}>{NO_COMPUTERS_NOTE}</Text>
  else {
    const projectDefault = row.project?.resolved_computer_id ?? null
    const choices: Choice[] = [
      { key: INHERIT, label: inheritComputerLabel(computerName(computers, projectDefault)) },
      ...computers.map((c) => ({ key: c.id, label: choiceLabel(c) }))
    ]
    const current = choices.find((c) => c.key === (binding ?? INHERIT))
    const runsOn = workComputerId({ computer_id: binding }, row.project)
    body = (
      <>
        <Pressable
          testID="task-computer-choice"
          accessibilityRole="button"
          style={styles.choice}
          onPress={() => setSheetOpen(true)}
        >
          <Text style={styles.choiceLabel} numberOfLines={1}>
            {current?.label ?? computerName(computers, binding)}
          </Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
        <Text style={styles.note}>{runsOnLabel(computerName(computers, runsOn))}</Text>
        <Text style={styles.hint}>A running agent keeps its computer until it restarts.</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <ChoiceSheet
          visible={sheetOpen}
          title="Run this task on"
          choices={choices}
          selectedKey={binding ?? INHERIT}
          onChoose={choose}
          onClose={() => setSheetOpen(false)}
        />
      </>
    )
  }

  return (
    <View style={styles.card} testID="task-computer">
      <Text style={styles.heading}>Computer</Text>
      {body}
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    card: { gap: 6 },
    heading: {
      fontSize: 12,
      fontWeight: '600',
      color: t.mutedForeground,
      textTransform: 'uppercase'
    },
    choice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.card
    },
    choiceLabel: { flex: 1, fontSize: 15, color: t.foreground },
    chevron: { fontSize: 18, color: t.mutedForeground },
    note: { fontSize: 13, color: t.mutedForeground },
    hint: { fontSize: 12, color: t.mutedForeground },
    error: { fontSize: 13, color: t.destructive }
  })
