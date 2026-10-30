/**
 * The agent's background jobs in this chat (`Bash` with `run_in_background`, tracked by
 * the reducer's `bgShells`) — desktop's `BackgroundJobsBanner`: each job's id, state,
 * exit code, age and command, newest last, with Stop for a running one
 * (`chat.stopCommandTask`). Collapsed to a count until opened.
 */
import type { BgShell, ChatTimelineState } from '@slayzone/terminal/reducer'
import { useEffect, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ChromeColors } from '../theme'
import { MONO, useThemedStyles } from './styles'
import { BG_STATUS_LABELS, bgShellList, formatAge, isActiveShell } from './timeline-rows'
import { useTRPCClient } from '../trpc'

export function BackgroundJobs({
  state,
  tabId,
  onError
}: {
  state: ChatTimelineState
  tabId: string
  onError: (message: string) => void
}) {
  const { s } = useThemedStyles(makeStyles)
  const client = useTRPCClient()
  const list = useMemo(() => bgShellList(state), [state])
  const [open, setOpen] = useState(false)
  const now = useNow(open && list.length > 0)
  const stop = (taskId: string): void => {
    client.chat.stopCommandTask
      .mutate({ tabId, taskId })
      .catch((err: unknown) =>
        onError(`Could not stop the job: ${err instanceof Error ? err.message : String(err)}`)
      )
  }
  if (list.length === 0) return null
  const active = list.filter(isActiveShell).length
  return (
    <View style={s.wrap} testID="background-jobs">
      <Pressable
        onPress={() => setOpen((o) => !o)}
        style={[s.header, active > 0 && s.headerActive]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Background jobs: ${active} running of ${list.length}`}
      >
        <Text style={s.headerText}>
          Background jobs {active}/{list.length}
        </Text>
        <Text style={s.headerText}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {open &&
        list.map((shell) => (
          <JobRow
            key={shell.spawnToolUseId}
            shell={shell}
            age={formatAge(now - shell.spawnedAt)}
            onStop={
              isActiveShell(shell) && shell.shellId
                ? () => stop(shell.shellId as string)
                : undefined
            }
            s={s}
          />
        ))}
    </View>
  )
}

type Styles = ReturnType<typeof makeStyles>

function JobRow({
  shell,
  age,
  onStop,
  s
}: {
  shell: BgShell
  age: string
  onStop?: () => void
  s: Styles
}) {
  const dot = {
    pending: s.dotInfo,
    running: s.dotWarning,
    completed: s.dotSuccess,
    killed: s.dotMuted,
    failed: s.dotError,
    unknown: s.dotWarning
  }[shell.status]
  return (
    <View style={s.row}>
      <View style={s.rowTop}>
        <View style={[s.dot, dot]} />
        <Text style={s.id}>{shell.shellId ?? '…'}</Text>
        <Text style={s.state}>
          {BG_STATUS_LABELS[shell.status]}
          {shell.exitCode !== null && shell.status !== 'running' ? ` (${shell.exitCode})` : ''} ·{' '}
          {age}
        </Text>
        {onStop && (
          <Pressable
            onPress={onStop}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Stop background job ${shell.shellId}`}
          >
            <Text style={s.stop}>Stop</Text>
          </Pressable>
        )}
      </View>
      <Text style={s.command} numberOfLines={2}>
        $ {shell.command || shell.description || ''}
      </Text>
    </View>
  )
}

/** The clock, ticking each second while `enabled`. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [enabled])
  return now
}

function makeStyles(t: ChromeColors) {
  return StyleSheet.create({
    wrap: {
      marginHorizontal: 8,
      marginTop: 6,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.surface1,
      overflow: 'hidden'
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 10,
      paddingVertical: 6
    },
    headerActive: { backgroundColor: t.surface2 },
    headerText: { color: t.warningForeground, fontSize: 12, fontWeight: '700' },
    row: {
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.border
    },
    rowTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    dotInfo: { backgroundColor: t.info },
    dotWarning: { backgroundColor: t.warning },
    dotSuccess: { backgroundColor: t.success },
    dotMuted: { backgroundColor: t.mutedForeground },
    dotError: { backgroundColor: t.destructive },
    id: { color: t.foreground, fontFamily: MONO, fontSize: 12 },
    state: { flex: 1, color: t.mutedForeground, fontSize: 12 },
    stop: { color: t.destructive, fontSize: 13, fontWeight: '600' },
    command: { color: t.mutedForeground, fontFamily: MONO, fontSize: 12, marginTop: 2 }
  })
}
