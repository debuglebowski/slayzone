/**
 * Markdown as native views, in the app's theme: GitHub-flavoured (tables, task lists,
 * strikethrough, autolinks) like desktop's chat (react-markdown + remark-gfm), parsed
 * by `marked`'s lexer (pure JS, no DOM, no native module) and drawn here. Text that is
 * still streaming renders as far as it goes: an unfinished `**` shows as typed.
 *
 * Links open in the browser, web links only. Images show as their alt text, linked.
 */
import { lexer, type Token, type Tokens } from 'marked'
import { memo, type ReactNode, useMemo } from 'react'
import { Linking, ScrollView, StyleSheet, Text, type TextStyle, View } from 'react-native'
import { type ChromeColors, useTheme } from '../theme'

export const Markdown = memo(function Markdown({
  text,
  muted = false
}: {
  text: string
  /** Secondary text (thinking): the muted foreground. */
  muted?: boolean
}) {
  const theme = useTheme()
  const styles = useMemo(() => makeStyles(theme, muted), [theme, muted])
  const tokens = useMemo(() => lexer(text), [text])
  return <View>{blocks(tokens, styles, 'b')}</View>
})

type Styles = ReturnType<typeof makeStyles>

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
        >
          {inline(t.tokens, s, key)}
        </Text>
      )
    }
    case 'paragraph':
      return (
        <Text key={key} style={[s.text, s.block]}>
          {inline((token as Tokens.Paragraph).tokens, s, key)}
        </Text>
      )
    case 'text': {
      // Block-level text (a tight list item's content).
      const t = token as Tokens.Text
      return (
        <Text key={key} style={s.text}>
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
          <Text style={s.codeText} selectable>
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
              <Text style={[s.text, s.bullet]}>
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
      const row = (cells: Tokens.TableCell[], header: boolean, rowKey: string) => (
        <View key={rowKey} style={s.tableRow}>
          {cells.map((cell, i) => (
            <View key={i} style={s.tableCell}>
              <Text style={[s.text, header && s.strong]}>
                {inline(cell.tokens, s, `${rowKey}.${i}`)}
              </Text>
            </View>
          ))}
        </View>
      )
      return (
        <ScrollView key={key} horizontal style={s.block}>
          <View style={s.table}>
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
        <Text key={key} style={[s.text, s.block]}>
          {(token as Tokens.HTML).text}
        </Text>
      )
    default:
      return 'raw' in token && typeof token.raw === 'string' ? (
        <Text key={key} style={[s.text, s.block]}>
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
        <Text key={key} style={s.link} onPress={() => openWebLink(t.href)} accessibilityRole="link">
          {inline(t.tokens, s, key)}
        </Text>
      )
    }
    case 'image': {
      const t = token as Tokens.Image
      return (
        <Text key={key} style={s.link} onPress={() => openWebLink(t.href)} accessibilityRole="link">
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

/** Open a link the agent wrote: web links only (never `file:`, app schemes, …). */
export function openWebLink(href: string): void {
  if (!/^https?:\/\//i.test(href)) return
  void Linking.openURL(href).catch(() => undefined)
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
    table: { borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, borderRadius: 4 },
    tableRow: { flexDirection: 'row' },
    tableCell: {
      minWidth: 80,
      maxWidth: 240,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border
    },
    hr: { height: StyleSheet.hairlineWidth, backgroundColor: t.border }
  })
}
