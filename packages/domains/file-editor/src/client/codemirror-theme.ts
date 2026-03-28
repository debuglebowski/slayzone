import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { Extension } from '@codemirror/state'
import type { EditorThemeColors } from '@slayzone/editor'

export function buildCodeMirrorTheme(colors: EditorThemeColors, isDark: boolean): Extension {
  const theme = EditorView.theme({
    '&': {
      color: colors.foreground,
      backgroundColor: colors.background,
    },
    '.cm-content': {
      caretColor: colors.cursor,
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: colors.cursor,
    },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: colors.selection,
    },
    '.cm-gutters': {
      backgroundColor: colors.gutterBackground,
      color: colors.gutterForeground,
      border: 'none',
    },
    '.cm-activeLine': {
      backgroundColor: colors.lineHighlight,
    },
    '.cm-activeLineGutter': {
      backgroundColor: colors.lineHighlight,
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: colors.selection,
    },
    '.cm-searchMatch': {
      backgroundColor: colors.selection,
    },
    '.cm-foldPlaceholder': {
      color: colors.comment,
    },
  }, { dark: isDark })

  const highlight = HighlightStyle.define([
    { tag: tags.keyword, color: colors.keyword },
    { tag: [tags.modifier, tags.operatorKeyword, tags.controlKeyword], color: colors.keyword },
    { tag: [tags.string, tags.special(tags.string), tags.inserted], color: colors.string },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: colors.comment, fontStyle: 'italic' },
    { tag: [tags.number, tags.integer, tags.float], color: colors.number },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: colors.function },
    { tag: [tags.typeName, tags.className, tags.namespace], color: colors.type },
    { tag: [tags.operator, tags.punctuation], color: colors.operator },
    { tag: [tags.variableName], color: colors.variable },
    { tag: [tags.propertyName], color: colors.property },
    { tag: [tags.definition(tags.variableName)], color: colors.variable },
    { tag: [tags.definition(tags.propertyName)], color: colors.property },
    { tag: [tags.tagName], color: colors.keyword },
    { tag: [tags.attributeName], color: colors.property },
    { tag: [tags.attributeValue], color: colors.string },
    { tag: tags.link, color: colors.link, textDecoration: 'underline' },
    { tag: tags.heading, color: colors.heading, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: [tags.bool, tags.null, tags.atom], color: colors.number },
    { tag: tags.regexp, color: colors.string },
    { tag: tags.escape, color: colors.number },
    { tag: tags.self, color: colors.keyword, fontStyle: 'italic' },
  ])

  return [theme, syntaxHighlighting(highlight)]
}
