/**
 * Organising a task, from its hub's board: subtasks (open one, add one: same project,
 * the project's default status, as desktop's quick add), the project's tags (toggle;
 * `tags.setForTask` with the whole set, as desktop), blockers (`task.getBlockers`;
 * add/remove) and the blocked flag with its comment. Every write goes to the task's hub
 * (these render inside its scope).
 */
import { useSubscription } from '@slayzone/transport/client'
import { getDefaultStatus } from '@slayzone/workflow'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import type { BoardData, TaskRow } from '../hub-board'
import { taskHref } from '../routes'
import { useTheme } from '../theme'
import { useTRPC, useTRPCClient } from '../trpc'
import { statusLabel } from './fields'
import { blockerCandidates, isBlocked, projectTags, subtasksOf, toggleTag } from './organise'
import { makeStyles, PromptSheet, Section, Sheet } from './ui'
import type { TaskWrites } from './use-task-writes'

export function SubtasksSection({
  row,
  board,
  writes
}: {
  row: TaskRow
  board: BoardData
  writes: TaskWrites
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const router = useRouter()
  const client = useTRPCClient()
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const subtasks = subtasksOf(board, row.task.id)

  const add = () => {
    const next = title.trim()
    if (!next) return
    setTitle('')
    void writes.run(() =>
      client.task.create.mutate({
        projectId: row.task.project_id,
        parentId: row.task.id,
        title: next,
        status: getDefaultStatus(row.project?.columns_config)
      })
    )
  }

  return (
    <Section title="Subtasks" action={{ label: 'Add subtask', onPress: () => setAdding(true) }}>
      {subtasks.map((sub) => (
        <Pressable
          key={sub.id}
          testID={`subtask-${sub.id}`}
          accessibilityRole="button"
          onPress={() => router.push(taskHref(row.hubLabel, sub.id))}
          style={styles.row}
        >
          <Text style={styles.rowText} numberOfLines={2}>
            {sub.title}
          </Text>
          <Text style={styles.muted}>{statusLabel(sub.status, row.project)}</Text>
        </Pressable>
      ))}
      {subtasks.length === 0 && !adding ? <Text style={styles.muted}>No subtasks</Text> : null}
      {adding ? (
        <TextInput
          testID="new-subtask-title"
          value={title}
          onChangeText={setTitle}
          onSubmitEditing={add}
          onBlur={() => setAdding(false)}
          submitBehavior="submit"
          returnKeyType="done"
          autoFocus
          placeholder="Subtask title"
          placeholderTextColor={theme.mutedForeground}
          style={styles.input}
        />
      ) : null}
    </Section>
  )
}

export function TagsSection({
  row,
  board,
  writes
}: {
  row: TaskRow
  board: BoardData
  writes: TaskWrites
}) {
  const styles = makeStyles(useTheme())
  const client = useTRPCClient()
  const [open, setOpen] = useState(false)
  const tags = projectTags(board, row.task.project_id)
  const saved = board.taskTags[row.task.id] ?? []
  // The set shown at once, until the board's reload carries the hub's (render-time sync).
  const [shown, setShown] = useState<readonly string[]>(saved)
  const savedKey = saved.join('\n')
  const [syncedFrom, setSyncedFrom] = useState({ taskId: row.task.id, savedKey })
  if (syncedFrom.taskId !== row.task.id || syncedFrom.savedKey !== savedKey) {
    setSyncedFrom({ taskId: row.task.id, savedKey })
    setShown(saved)
  }

  const toggle = (tagId: string) => {
    const tagIds = toggleTag(shown, tagId)
    setShown(tagIds)
    void writes
      .run(() => client.tags.setForTask.mutate({ taskId: row.task.id, tagIds }).then(() => true))
      .then((ok) => {
        if (!ok) setShown(saved)
      })
  }

  const selected = tags.filter((t) => shown.includes(t.id))
  return (
    <Section
      title="Tags"
      action={
        tags.length > 0
          ? { label: 'Edit', onPress: () => setOpen(true), testID: 'edit-tags' }
          : undefined
      }
    >
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {selected.map((t) => (
          <Text
            key={t.id}
            style={[styles.fieldText, tagStyle, { backgroundColor: t.color, color: t.text_color }]}
          >
            {t.name}
          </Text>
        ))}
        {selected.length === 0 ? (
          <Text style={styles.muted}>{tags.length > 0 ? 'None' : 'This project has no tags'}</Text>
        ) : null}
      </View>
      <Sheet
        visible={open}
        title="Tags"
        testID="tag-sheet"
        closeLabel="Done"
        onClose={() => setOpen(false)}
      >
        <ScrollView>
          {tags.map((t) => {
            const on = shown.includes(t.id)
            return (
              <Pressable
                key={t.id}
                testID={`tag-${t.id}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                onPress={() => toggle(t.id)}
                style={styles.row}
              >
                <Text style={styles.rowText}>{on ? '☑' : '☐'}</Text>
                <Text
                  style={[
                    styles.fieldText,
                    tagStyle,
                    { backgroundColor: t.color, color: t.text_color }
                  ]}
                >
                  {t.name}
                </Text>
                <View style={{ flex: 1 }} />
              </Pressable>
            )
          })}
        </ScrollView>
      </Sheet>
    </Section>
  )
}

const tagStyle = {
  paddingHorizontal: 8,
  paddingVertical: 4,
  borderRadius: 6,
  overflow: 'hidden'
} as const

export function BlockersSection({
  row,
  board,
  writes
}: {
  row: TaskRow
  board: BoardData
  writes: TaskWrites
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const trpc = useTRPC()
  const client = useTRPCClient()
  const queryClient = useQueryClient()
  const taskId = row.task.id
  const { task } = writes
  const blockersQ = useQuery(trpc.task.getBlockers.queryOptions({ taskId }))
  const reloadBlockers = () =>
    void queryClient.invalidateQueries(trpc.task.getBlockers.queryFilter({ taskId }))
  // Another client (un)blocked it: the hub says its tasks changed.
  useSubscription(
    trpc.notify.onTasksChanged.subscriptionOptions(undefined, { onData: reloadBlockers })
  )
  const [picking, setPicking] = useState(false)
  const [commenting, setCommenting] = useState(false)
  const [query, setQuery] = useState('')

  const blockers = blockersQ.data ?? []
  const blockerIds = blockers.map((b) => b.id)
  const blocked = task.is_blocked || isBlocked(board, taskId)

  const add = (blockerTaskId: string) => {
    setPicking(false)
    setQuery('')
    void writes
      .run(() => client.task.addBlocker.mutate({ taskId, blockerTaskId }))
      .then(reloadBlockers)
  }
  const remove = (blockerTaskId: string) =>
    void writes
      .run(() => client.task.removeBlocker.mutate({ taskId, blockerTaskId }))
      .then(reloadBlockers)

  return (
    <Section title="Blocked by" action={{ label: 'Add blocker', onPress: () => setPicking(true) }}>
      {blocked ? <Text style={styles.destructive}>Blocked</Text> : null}
      {task.blocked_comment ? (
        <View style={styles.row}>
          <Text style={styles.rowText}>{task.blocked_comment}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear the comment"
            hitSlop={8}
            onPress={() => void writes.update({ blocked_comment: null }, { blockedComment: null })}
          >
            <Text style={styles.muted}>✕</Text>
          </Pressable>
        </View>
      ) : null}
      {blockers.map((b) => (
        <View key={b.id} testID={`blocker-${b.id}`} style={styles.row}>
          <Text style={styles.rowText} numberOfLines={2}>
            {b.title}
          </Text>
          <Pressable
            testID={`remove-blocker-${b.id}`}
            accessibilityRole="button"
            accessibilityLabel={`Remove blocker ${b.title}`}
            hitSlop={8}
            onPress={() => remove(b.id)}
          >
            <Text style={styles.muted}>✕</Text>
          </Pressable>
        </View>
      ))}
      {blockersQ.error ? <Text style={styles.error}>{blockersQ.error.message}</Text> : null}
      {task.is_blocked ? (
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            void writes.update(
              { is_blocked: false, blocked_comment: null },
              { isBlocked: false, blockedComment: null }
            )
          }
        >
          <Text style={styles.link}>Unblock</Text>
        </Pressable>
      ) : (
        <Pressable accessibilityRole="button" onPress={() => setCommenting(true)}>
          <Text style={styles.link}>Mark blocked</Text>
        </Pressable>
      )}
      {commenting ? (
        <PromptSheet
          visible
          title="Mark blocked"
          placeholder="Why? (optional)"
          submitLabel="Block"
          inputTestID="blocked-comment"
          onSubmit={(text) => {
            const blockedComment = text.trim() || null
            void writes.update(
              { is_blocked: true, blocked_comment: blockedComment },
              { isBlocked: true, blockedComment }
            )
          }}
          onClose={() => setCommenting(false)}
        />
      ) : null}
      <Sheet
        visible={picking}
        title="Add blocker"
        testID="blocker-sheet"
        onClose={() => setPicking(false)}
      >
        <View style={styles.prompt}>
          <TextInput
            testID="blocker-search"
            value={query}
            onChangeText={setQuery}
            placeholder="Search tasks"
            placeholderTextColor={theme.mutedForeground}
            style={styles.input}
            autoCorrect={false}
          />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled">
          {picking
            ? blockerCandidates(board, taskId, blockerIds, query).map((t) => (
                <Pressable
                  key={t.id}
                  accessibilityRole="button"
                  onPress={() => add(t.id)}
                  style={styles.row}
                >
                  <Text style={styles.rowText} numberOfLines={2}>
                    {t.title}
                  </Text>
                </Pressable>
              ))
            : null}
        </ScrollView>
      </Sheet>
    </Section>
  )
}
