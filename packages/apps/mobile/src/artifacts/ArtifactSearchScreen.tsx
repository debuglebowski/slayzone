/**
 * Search the artifacts of every signed-in hub: titles and contents (each artifact's
 * current version), with desktop's search options — Match case (`Aa`) and Regular
 * expression (`.*`). Results grouped by artifact like desktop's search panel: title,
 * its task, its hub (with several), and each matching line with its number; a group
 * folds away. A hub that fails says why below the others' results. Tapping a result opens
 * that artifact on its own hub.
 */
import { useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { findTaskRow, type HubFeed } from '../hub-board'
import type { HubSession } from '../hub-session'
import { type ChromeColors, useTheme } from '../theme'
import { hubTarget } from './hub-rest'
import type { HubArtifactSearchResult } from './search'
import { HeaderButton, ScreenHeader } from './ScreenHeader'
import { useArtifactSearch } from './use-artifact-search'
import { extensionBadge } from './viewer-kind'

export function ArtifactSearchScreen({
  sessions,
  feeds,
  onOpen,
  onBack
}: {
  sessions: readonly HubSession[]
  feeds: readonly HubFeed[]
  onOpen: (result: HubArtifactSearchResult) => void
  onBack: () => void
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const [q, setQ] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set())
  const targets = sessions.map(hubTarget)
  const { outcome, searching } = useArtifactSearch(targets, { q, caseSensitive, regex })
  const severalHubs = sessions.length > 1

  const taskTitle = (result: HubArtifactSearchResult): string | null => {
    const feed = feeds.find((f) => f.hub.id === result.hubId)
    return (feed && findTaskRow(feed, result.taskId)?.task.title) ?? null
  }
  const toggleFold = (key: string) => {
    const next = new Set(folded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setFolded(next)
  }

  const failures = outcome?.hubs.filter((h) => !h.ok) ?? []
  const truncated = outcome?.hubs.filter((h) => h.ok && h.truncated) ?? []

  return (
    <View style={styles.screen}>
      <ScreenHeader title="Search artifacts" onBack={onBack} backLabel="Home" />
      <View style={styles.bar}>
        <TextInput
          testID="artifact-search-input"
          style={styles.input}
          value={q}
          onChangeText={setQ}
          placeholder="Search titles and contents"
          placeholderTextColor={theme.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
        <HeaderButton
          label="Aa"
          accessibilityLabel="Match case"
          active={caseSensitive}
          onPress={() => setCaseSensitive((v) => !v)}
        />
        <HeaderButton
          label=".*"
          accessibilityLabel="Regular expression"
          active={regex}
          onPress={() => setRegex((v) => !v)}
        />
      </View>
      {!q.trim() ? null : searching ? (
        <View style={styles.center}>
          <ActivityIndicator testID="artifact-search-searching" />
        </View>
      ) : (
        <FlatList
          data={outcome?.results ?? []}
          keyExtractor={(r) => r.key}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <ResultGroup
              result={item}
              taskTitle={taskTitle(item)}
              hubLabel={severalHubs ? item.hubLabel : null}
              folded={folded.has(item.key)}
              onToggle={() => toggleFold(item.key)}
              onOpen={() => onOpen(item)}
            />
          )}
          ListEmptyComponent={<Text style={styles.note}>No results</Text>}
          ListFooterComponent={
            <View style={styles.footer}>
              {failures.map((h) =>
                h.ok ? null : (
                  <Text
                    key={h.hubId}
                    style={styles.failure}
                    testID={`artifact-search-failed-${h.hubLabel}`}
                  >
                    {h.hubLabel}: {h.error}
                  </Text>
                )
              )}
              {truncated.map((h) => (
                <Text key={h.hubId} style={styles.note}>
                  {h.hubLabel} has more results; refine the search.
                </Text>
              ))}
            </View>
          }
        />
      )}
    </View>
  )
}

function ResultGroup({
  result,
  taskTitle,
  hubLabel,
  folded,
  onToggle,
  onOpen
}: {
  result: HubArtifactSearchResult
  taskTitle: string | null
  hubLabel: string | null
  folded: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const styles = makeStyles(useTheme())
  const lines = result.matches.filter((m) => m.type === 'content')
  const badge = extensionBadge(result.title)
  const context = [taskTitle, hubLabel].filter(Boolean).join(' · ')
  return (
    <View style={styles.group}>
      <View style={styles.groupHead}>
        {lines.length > 0 ? (
          <Pressable
            onPress={onToggle}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{ expanded: !folded }}
          >
            <Text style={styles.chevron}>{folded ? '▸' : '▾'}</Text>
          </Pressable>
        ) : (
          <Text style={styles.chevron}> </Text>
        )}
        <Pressable
          style={styles.groupTitle}
          onPress={onOpen}
          accessibilityRole="button"
          testID={`artifact-search-result-${result.artifactId}`}
        >
          <View style={styles.titleLine}>
            <Text style={styles.title} numberOfLines={1}>
              {result.title}
            </Text>
            {badge ? <Text style={styles.badge}>{badge}</Text> : null}
            {lines.length > 0 ? <Text style={styles.count}>{lines.length}</Text> : null}
          </View>
          {context ? (
            <Text style={styles.context} numberOfLines={1}>
              {context}
            </Text>
          ) : null}
        </Pressable>
      </View>
      {folded
        ? null
        : lines.map((m, i) => (
            <Pressable
              key={`${m.line ?? i}-${i}`}
              onPress={onOpen}
              style={styles.line}
              accessibilityRole="button"
            >
              <Text style={styles.lineNumber}>{m.line ?? ''}</Text>
              <Text style={styles.snippet} numberOfLines={2}>
                {m.snippet}
              </Text>
            </Pressable>
          ))}
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border
    },
    input: {
      flex: 1,
      fontSize: 16,
      color: t.foreground,
      backgroundColor: t.muted,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8
    },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    note: { color: t.mutedForeground, textAlign: 'center', padding: 16 },
    footer: { paddingBottom: 24 },
    failure: { color: t.destructive, paddingHorizontal: 16, paddingVertical: 6, fontSize: 13 },
    group: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
      paddingVertical: 6
    },
    groupHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingHorizontal: 12 },
    chevron: { width: 16, fontSize: 13, color: t.mutedForeground, paddingTop: 3 },
    groupTitle: { flex: 1, paddingVertical: 2 },
    titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { flexShrink: 1, fontSize: 15, fontWeight: '500', color: t.foreground },
    badge: {
      fontSize: 10,
      fontWeight: '600',
      color: t.mutedForeground,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      borderRadius: 4,
      paddingHorizontal: 4,
      overflow: 'hidden'
    },
    count: { fontSize: 12, color: t.mutedForeground },
    context: { fontSize: 12, color: t.mutedForeground, marginTop: 2 },
    line: { flexDirection: 'row', gap: 8, paddingLeft: 34, paddingRight: 16, paddingVertical: 4 },
    lineNumber: {
      width: 36,
      textAlign: 'right',
      fontSize: 12,
      color: t.mutedForeground,
      fontFamily: 'Menlo'
    },
    snippet: { flex: 1, fontSize: 13, color: t.foreground, fontFamily: 'Menlo' }
  })
