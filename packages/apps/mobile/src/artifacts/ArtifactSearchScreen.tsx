/**
 * Search the artifacts of every signed-in hub: titles and contents (each artifact's
 * current version), with desktop's search options — Match case (`Aa`) and Regular
 * expression (`.*`). Results grouped by artifact like desktop's search panel: title,
 * its task, its hub (with several), and each matching line with its number; a group
 * folds away, and the query is highlighted in each line. A hub that fails says why below
 * the others' results, as do files a hub skipped as too large. Tapping a result opens
 * that artifact on its own hub; dragging the results puts the keyboard away.
 */
import { type ReactNode, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { findTaskRow, type HubFeed } from '../hub-board'
import type { HubSession } from '../hub-session'
import { type ChromeColors, useTheme } from '../theme'
import { hubTarget } from './hub-rest'
import type { ArtifactSearchQuery, HubArtifactSearchResult } from './search'
import { highlightParts } from './search-highlight'
import { HeaderButton, ScreenHeader } from './ScreenHeader'
import { useArtifactSearch } from './use-artifact-search'
import { extensionBadge } from './viewer-kind'

export function ArtifactSearchScreen({
  sessions,
  feeds,
  onOpen,
  title = 'Search artifacts',
  placeholder = 'Search titles and contents',
  initialQuery = '',
  largeTitle = false,
  before
}: {
  sessions: readonly HubSession[]
  feeds: readonly HubFeed[]
  onOpen: (result: HubArtifactSearchResult) => void
  title?: string
  placeholder?: string
  /** What to search for at first (a link's `?q=`). */
  initialQuery?: string
  /** A tab's root: the title large (no back). */
  largeTitle?: boolean
  /** Other results for the same query, shown above the artifacts' (the Search tab's tasks). */
  before?: (q: string, options: Pick<ArtifactSearchQuery, 'caseSensitive' | 'regex'>) => ReactNode
}) {
  const theme = useTheme()
  const styles = makeStyles(theme)
  const [q, setQ] = useState(initialQuery)
  // A later link with another query searches for it (render-time sync).
  const [linkedQuery, setLinkedQuery] = useState(initialQuery)
  if (initialQuery !== linkedQuery) {
    setLinkedQuery(initialQuery)
    setQ(initialQuery)
  }
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
  const skipped = (outcome?.hubs ?? []).flatMap((h) =>
    h.ok && h.skippedLarge.length > 0 ? [{ hub: h, files: h.skippedLarge }] : []
  )
  // What the shown results were searched for (the query may have moved on since).
  const highlight = { q: q.trim(), caseSensitive, regex }

  return (
    <View style={styles.screen}>
      {largeTitle ? (
        <Text style={styles.largeTitle} accessibilityRole="header">
          {title}
        </Text>
      ) : (
        <ScreenHeader title={title} />
      )}
      <View style={styles.bar}>
        <TextInput
          testID="artifact-search-input"
          style={styles.input}
          value={q}
          onChangeText={setQ}
          placeholder={placeholder}
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
      {!q.trim() ? (
        <ScrollView
          testID="artifact-search-empty"
          style={styles.fill}
          contentContainerStyle={styles.fill}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          alwaysBounceVertical
        >
          <Pressable
            testID="artifact-search-dismiss-keyboard"
            accessible={false}
            style={styles.fill}
            onPress={Keyboard.dismiss}
          />
        </ScrollView>
      ) : searching && !before ? (
        <View style={styles.center}>
          <ActivityIndicator testID="artifact-search-searching" />
        </View>
      ) : (
        <FlatList
          testID="artifact-search-list"
          keyboardDismissMode="on-drag"
          data={searching ? [] : (outcome?.results ?? [])}
          ListHeaderComponent={before ? <>{before(q, { caseSensitive, regex })}</> : undefined}
          keyExtractor={(r) => r.key}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <ResultGroup
              result={item}
              taskTitle={taskTitle(item)}
              hubLabel={severalHubs ? item.hubLabel : null}
              folded={folded.has(item.key)}
              highlight={highlight}
              onToggle={() => toggleFold(item.key)}
              onOpen={() => onOpen(item)}
            />
          )}
          ListEmptyComponent={
            searching ? (
              <View style={styles.center}>
                <ActivityIndicator testID="artifact-search-searching" />
              </View>
            ) : (
              <Text style={styles.note}>{before ? 'No artifacts found' : 'No results'}</Text>
            )
          }
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
              {skipped.map(({ hub, files }) => (
                <Text key={`skipped-${hub.hubId}`} style={styles.note}>
                  Too large to search{severalHubs ? ` on ${hub.hubLabel}` : ''}:{' '}
                  {files.map((f) => f.label).join(', ')}
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
  highlight,
  onToggle,
  onOpen
}: {
  result: HubArtifactSearchResult
  taskTitle: string | null
  hubLabel: string | null
  folded: boolean
  highlight: { q: string; caseSensitive: boolean; regex: boolean }
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
            hitSlop={{ top: 12, bottom: 12, left: 14, right: 14 }}
            accessibilityRole="button"
            // VoiceOver: what it does, not the chevron glyph.
            accessibilityLabel={`Matching lines in ${result.title}`}
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
            <Text style={styles.title} numberOfLines={1} ellipsizeMode="middle">
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
                {highlightParts(m.snippet, highlight.q, highlight).map((part, j) =>
                  part.match ? (
                    <Text key={j} style={styles.hit} testID="artifact-search-hit">
                      {part.text}
                    </Text>
                  ) : (
                    part.text
                  )
                )}
              </Text>
            </Pressable>
          ))}
    </View>
  )
}

const makeStyles = (t: ChromeColors) =>
  StyleSheet.create({
    largeTitle: {
      fontSize: 24,
      fontWeight: '700',
      color: t.foreground,
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 4
    },
    screen: { flex: 1, backgroundColor: t.background },
    fill: { flexGrow: 1 },
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
    snippet: { flex: 1, fontSize: 13, color: t.foreground, fontFamily: 'Menlo' },
    hit: { backgroundColor: t.accent, color: t.accentForeground, fontWeight: '600' }
  })
