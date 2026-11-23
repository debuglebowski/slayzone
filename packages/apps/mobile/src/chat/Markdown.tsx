/**
 * Markdown as native views, in the app's theme: GitHub-flavoured (tables, task lists,
 * strikethrough, autolinks) like desktop's chat (react-markdown + remark-gfm), parsed
 * by `marked`'s lexer (pure JS, no DOM, no native module) and drawn here. Text that is
 * still streaming renders as far as it goes: an unfinished `**` shows as typed.
 *
 * Links open in the in-app browser (Safari View Controller: the app stays where it was),
 * web links only — unless `onLink` takes them first (a task description's `artifact:`
 * links open the artifact). Images show as their alt text, linked. A table's columns line
 * up: each column one width (from its longest cell, capped), cells aligned as written.
 */
import * as WebBrowser from 'expo-web-browser'
import { lexer, type Token, type Tokens } from 'marked'
import { memo, type ReactNode, useMemo } from 'react'
import { Linking, ScrollView, StyleSheet, Text, type TextStyle, View } from 'react-native'
import { type ChromeColors, useTheme } from '../theme'

export const Markdown = memo(function Markdown({
  text,
  muted = false,
  onLink,
  onLongPress
}: {
  text: string
  /** Secondary text (thinking): the muted foreground. */
  muted?: boolean
  /** A link was pressed: true = handled here, else it opens as a web link. */
  onLink?: (href: string) => boolean
  /** Opens the message menu from its text. Attach it inside any horizontal scroller. */
  onLongPress?: () => void
}) {
  const theme = useTheme()
  const styles = useMemo<Styles>(
    () => ({
      ...makeStyles(theme, muted),
      onLongPress,
      openLink: (href: string) => {
        if (!onLink?.(href)) openWebLink(href)
      }
    }),
    [theme, muted, onLink, onLongPress]
  )
  const tokens = useMemo(() => lexer(text), [text])
  return <View>{blocks(tokens, styles, 'b')}</View>
})

type Styles = ReturnType<typeof makeStyles> & {
  openLink: (href: string) => void
  onLongPress: (() => void) | undefined
}

function blocks(tokens: readonly Token[], s: Styles, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  tokens.forEach((token, i) => {
    const node = block(token, s, `${keyPrefix}.${i}`)
    if (node !== null) out.push(node)
  })
  return out
}

function block(token: Token, s: Styles, key: string): ReactNode {
  switch (token.type) {
    case 'space':
    case 'def':
      return null
    case 'heading': {
      const t = token as Tokens.Heading
      return (
        <Text
          key={key}
          style={[s.text, s.heading, headingSize(t.depth)]}
          accessibilityRole="header"
          onLongPress={s.onLongPress}
        >
          {inline(t.tokens, s, key)}
        </Text>
      )
    }
    case 'paragraph':
      return (
        <Text key={key} style={[s.text, s.block]} onLongPress={s.onLongPress}>
          {inline((token as Tokens.Paragraph).tokens, s, key)}
        </Text>
      )
    case 'text': {
      // Block-level text (a tight list item's content).
      const t = token as Tokens.Text
      return (
        <Text key={key} style={s.text} onLongPress={s.onLongPress}>
          {t.tokens ? inline(t.tokens, s, key) : decode(t.text)}
        </Text>
      )
    }
    case 'code': {
      const t = token as Tokens.Code
      return (
        <ScrollView
          key={key}
          horizontal
          style={[s.codeBlock, s.block]}
          contentContainerStyle={s.codePad}
        >
          <Text style={s.codeText} selectable onLongPress={s.onLongPress}>
            {t.text}
          </Text>
        </ScrollView>
      )
    }
    case 'blockquote':
      return (
        <View key={key} style={[s.quote, s.block]}>
          {blocks((token as Tokens.Blockquote).tokens, s, key)}
        </View>
      )
    case 'list': {
      const t = token as Tokens.List
      const start = typeof t.start === 'number' ? t.start : 1
      return (
        <View key={key} style={s.block}>
          {t.items.map((item, i) => (
            <View key={i} style={s.listItem}>
              <Text style={[s.text, s.bullet]} onLongPress={s.onLongPress}>
                {t.ordered ? `${start + i}.` : item.task ? (item.checked ? '☑' : '☐') : '•'}
              </Text>
              <View style={s.listBody}>
                {blocks(
                  item.tokens.filter((c) => c.type !== 'checkbox'),
                  s,
                  `${key}.${i}`
                )}
              </View>
            </View>
          ))}
        </View>
      )
    }
    case 'table': {
      const t = token as Tokens.Table
      const widths = columnWidths([t.header, ...t.rows])
      const width = widths.reduce((sum, cell) => sum + cell, 0) + 2 * StyleSheet.hairlineWidth
      const row = (cells: Tokens.TableCell[], header: boolean, rowKey: string) => (
        <View key={rowKey} style={s.tableRow}>
          {cells.map((cell, i) => (
            <View key={i} style={[s.tableCell, { width: widths[i] }]}>
              <Text
                style={[s.text, header && s.strong, alignOf(t.align[i] ?? cell.align)]}
                onLongPress={s.onLongPress}
              >
                {inline(cell.tokens, s, `${rowKey}.${i}`)}
              </Text>
            </View>
          ))}
        </View>
      )
      return (
        <ScrollView
          key={key}
          testID="markdown-table-scroll"
          horizontal
          directionalLockEnabled
          style={[s.block, s.tableViewport]}
        >
          <View style={[s.table, { width }]}>
            {row(t.header, true, `${key}.h`)}
            {t.rows.map((cells, i) => row(cells, false, `${key}.${i}`))}
          </View>
        </ScrollView>
      )
    }
    case 'hr':
      return <View key={key} style={[s.hr, s.block]} />
    case 'html':
      return (
        <Text key={key} style={[s.text, s.block]} onLongPress={s.onLongPress}>
          {(token as Tokens.HTML).text}
        </Text>
      )
    default:
      return 'raw' in token && typeof token.raw === 'string' ? (
        <Text key={key} style={[s.text, s.block]} onLongPress={s.onLongPress}>
          {token.raw}
        </Text>
      ) : null
  }
}

function inline(tokens: readonly Token[] | undefined, s: Styles, keyPrefix: string): ReactNode[] {
  if (!tokens) return []
  return tokens.map((token, i) => inlineToken(token, s, `${keyPrefix}.${i}`))
}

function inlineToken(token: Token, s: Styles, key: string): ReactNode {
  switch (token.type) {
    case 'text': {
      const t = token as Tokens.Text
      return t.tokens ? (
        <Text key={key}>{inline(t.tokens, s, key)}</Text>
      ) : (
        <Text key={key}>{decode(t.text)}</Text>
      )
    }
    case 'escape':
      return <Text key={key}>{decode((token as Tokens.Escape).text)}</Text>
    case 'strong':
      return (
        <Text key={key} style={s.strong}>
          {inline((token as Tokens.Strong).tokens, s, key)}
        </Text>
      )
    case 'em':
      return (
        <Text key={key} style={s.em}>
          {inline((token as Tokens.Em).tokens, s, key)}
        </Text>
      )
    case 'del':
      return (
        <Text key={key} style={s.del}>
          {inline((token as Tokens.Del).tokens, s, key)}
        </Text>
      )
    case 'codespan':
      return (
        <Text key={key} style={s.codeSpan}>
          {decode((token as Tokens.Codespan).text)}
        </Text>
      )
    case 'br':
      return <Text key={key}>{'\n'}</Text>
    case 'link': {
      const t = token as Tokens.Link
      return (
        <Text key={key} style={s.link} onPress={() => s.openLink(t.href)} accessibilityRole="link">
          {inline(t.tokens, s, key)}
        </Text>
      )
    }
    case 'image': {
      const t = token as Tokens.Image
      return (
        <Text key={key} style={s.link} onPress={() => s.openLink(t.href)} accessibilityRole="link">
          {t.text || t.href}
        </Text>
      )
    }
    case 'html':
      return <Text key={key}>{(token as Tokens.HTML).text}</Text>
    case 'checkbox':
      return <Text key={key}>{(token as Tokens.Checkbox).checked ? '☑ ' : '☐ '}</Text>
    default:
      return 'raw' in token && typeof token.raw === 'string' ? (
        <Text key={key}>{token.raw}</Text>
      ) : null
  }
}

/** Open a link the agent wrote, in the in-app browser: web links only (never `file:`, app schemes, …). */
export function openWebLink(href: string): void {
  if (!/^https?:\/\//i.test(href)) return
  void WebBrowser.openBrowserAsync(href).catch(() => Linking.openURL(href).catch(() => undefined))
}

/** Per column: wide enough for its longest cell (≈ 8pt a character), within bounds. */
const CELL_MIN = 60
const CELL_MAX = 240
const CHAR_WIDTH = 8
const CELL_PAD = 16
function columnWidths(rows: readonly Tokens.TableCell[][]): number[] {
  const widths: number[] = []
  for (const cells of rows) {
    cells.forEach((cell, i) => {
      const w = Math.min(CELL_MAX, Math.max(CELL_MIN, cell.text.length * CHAR_WIDTH + CELL_PAD))
      widths[i] = Math.max(widths[i] ?? 0, w)
    })
  }
  return widths
}

function alignOf(align: 'left' | 'center' | 'right' | null | undefined): TextStyle | undefined {
  return align ? { textAlign: align } : undefined
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'"
}

/** The lexer keeps character entities as written; text shows the character. */
function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m) => ENTITIES[m] ?? m)
}

function headingSize(depth: number): TextStyle {
  const sizes = [22, 19, 17, 16, 15, 15]
  return { fontSize: sizes[Math.min(depth, 6) - 1], lineHeight: sizes[Math.min(depth, 6) - 1] + 6 }
}

const MONO = 'Menlo'

function makeStyles(t: ChromeColors, muted: boolean) {
  return StyleSheet.create({
    text: { color: muted ? t.mutedForeground : t.foreground, fontSize: 15, lineHeight: 21 },
    block: { marginBottom: 8 },
    heading: { fontWeight: '700', marginTop: 4, marginBottom: 6 },
    strong: { fontWeight: '700' },
    em: { fontStyle: 'italic' },
    del: { textDecorationLine: 'line-through' },
    link: { color: t.infoForeground, textDecorationLine: 'underline' },
    codeSpan: {
      fontFamily: MONO,
      fontSize: 13,
      backgroundColor: t.surface2,
      color: t.foreground
    },
    codeBlock: {
      backgroundColor: t.surface1,
      borderRadius: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    codePad: { padding: 10 },
    codeText: { fontFamily: MONO, fontSize: 13, lineHeight: 18, color: t.foreground },
    quote: { borderLeftWidth: 3, borderLeftColor: t.border, paddingLeft: 10 },
    listItem: { flexDirection: 'row', marginBottom: 2 },
    bullet: { width: 22, color: t.mutedForeground },
    listBody: { flex: 1 },
    tableViewport: { width: '100%', flexGrow: 0 },
    table: { borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, borderRadius: 4 },
    tableRow: { flexDirection: 'row' },
    tableCell: {
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    hr: { height: StyleSheet.hairlineWidth, backgroundColor: t.border }
  })
}
