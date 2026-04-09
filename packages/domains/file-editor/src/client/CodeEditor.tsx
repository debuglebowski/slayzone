import { useEffect, useMemo, useRef } from 'react'
import { useAppearance } from '@slayzone/settings/client'
import { useTheme } from '@slayzone/settings/client'
import { getThemeEditorColors } from '@slayzone/ui'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { keymap, highlightWhitespace } from '@codemirror/view'
import { indentMore, indentLess } from '@codemirror/commands'
import { indentUnit, LRLanguage, LanguageSupport } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { go } from '@codemirror/lang-go'
import { yaml } from '@codemirror/lang-yaml'
import { sql } from '@codemirror/lang-sql'
import { hcl } from 'codemirror-lang-hcl'
import { parser as tomlParser } from 'lezer-toml'
import { buildCodeMirrorTheme } from './codemirror-theme'

const tomlLanguage = LRLanguage.define({ parser: tomlParser })
function toml() { return new LanguageSupport(tomlLanguage) }

function getLanguage(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
      return javascript()
    case 'ts':
    case 'tsx':
    case 'mts':
      return javascript({ typescript: true, jsx: ext.includes('x') })
    case 'json':
      return json()
    case 'css':
      return css()
    case 'html':
    case 'htm':
      return html()
    case 'md':
    case 'mdx':
      return markdown()
    case 'py':
      return python()
    case 'go':
      return go()
    case 'yaml':
    case 'yml':
      return yaml()
    case 'sql':
      return sql()
    case 'toml':
      return toml()
    case 'tf':
    case 'tfvars':
      return hcl()
    default:
      return null
  }
}


interface CodeEditorProps {
  filePath: string
  content: string
  onChange: (content: string) => void
  onSave: () => void
  /** Bump to replace editor content from external source (e.g. disk reload) */
  version?: number
  /** Navigate to line/col and focus editor */
  goToPosition?: { line: number; col: number } | null
  onGoToPositionApplied?: () => void
}

export function CodeEditor({ filePath, content, onChange, onSave, version, goToPosition, onGoToPositionApplied }: CodeEditorProps) {
  const { editorThemeId, contentVariant } = useTheme()
  const {
    editorFontSize, editorWordWrap, editorTabSize, editorIndentTabs, editorRenderWhitespace,
  } = useAppearance()

  const resolvedEditorColors = getThemeEditorColors(editorThemeId, contentVariant)
  const cmThemeExt = useMemo(
    () => buildCodeMirrorTheme(resolvedEditorColors, contentVariant === 'dark'),
    [editorThemeId, contentVariant]
  )

  const sizeTheme = useMemo(() => EditorView.theme({
    '&': { height: '100%', fontSize: `${editorFontSize}px` },
    '.cm-scroller': { overflow: 'auto' },
    '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  }), [editorFontSize])
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const contentRef = useRef(content)
  const suppressOnChange = useRef(false)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  contentRef.current = content

  // Compartments for runtime-reconfigurable extensions
  const themeComp = useRef(new Compartment())
  const tabSizeComp = useRef(new Compartment())
  const indentComp = useRef(new Compartment())
  const wrapComp = useRef(new Compartment())
  const whitespaceComp = useRef(new Compartment())

  // Create editor on mount / filePath change
  useEffect(() => {
    if (!containerRef.current) return

    const lang = getLanguage(filePath)
    const extensions = [
      basicSetup,
      sizeTheme,
      themeComp.current.of(cmThemeExt),
      keymap.of([
        {
          key: 'Tab',
          run: (view) => {
            if (view.state.selection.ranges.some(r => !r.empty))
              return indentMore(view)
            const unit = view.state.facet(indentUnit)
            view.dispatch(view.state.update(view.state.replaceSelection(unit), { scrollIntoView: true, userEvent: 'input' }))
            return true
          },
        },
        { key: 'Shift-Tab', run: indentLess },
        {
          key: 'Mod-s',
          run: () => {
            onSaveRef.current()
            return true
          }
        }
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !suppressOnChange.current) {
          onChangeRef.current(update.state.doc.toString())
        }
      }),
      tabSizeComp.current.of(EditorState.tabSize.of(editorTabSize)),
      indentComp.current.of(indentUnit.of(editorIndentTabs ? '\t' : ' '.repeat(editorTabSize))),
      wrapComp.current.of(editorWordWrap === 'on' ? EditorView.lineWrapping : []),
      whitespaceComp.current.of(editorRenderWhitespace !== 'none' ? highlightWhitespace() : []),
    ]
    if (lang) extensions.splice(1, 0, lang)

    const state = EditorState.create({ doc: content, extensions })
    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, sizeTheme])

  // Navigate to line/col and focus
  const onGoToRef = useRef(onGoToPositionApplied)
  onGoToRef.current = onGoToPositionApplied
  useEffect(() => {
    const view = viewRef.current
    if (!view || !goToPosition) return
    const line = Math.max(1, Math.min(goToPosition.line, view.state.doc.lines))
    const lineObj = view.state.doc.line(line)
    const col = Math.min(goToPosition.col, lineObj.length)
    const pos = lineObj.from + col
    view.dispatch({
      selection: { anchor: pos },
      scrollIntoView: true,
    })
    view.focus()
    onGoToRef.current?.()
  }, [goToPosition])

  // Reconfigure theme at runtime
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: [themeComp.current.reconfigure(cmThemeExt)] })
  }, [cmThemeExt])

  // Reconfigure editor settings at runtime without destroying the view
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: [
        tabSizeComp.current.reconfigure(EditorState.tabSize.of(editorTabSize)),
        indentComp.current.reconfigure(indentUnit.of(editorIndentTabs ? '\t' : ' '.repeat(editorTabSize))),
        wrapComp.current.reconfigure(editorWordWrap === 'on' ? EditorView.lineWrapping : []),
        whitespaceComp.current.reconfigure(editorRenderWhitespace !== 'none' ? highlightWhitespace() : []),
      ]
    })
  }, [editorWordWrap, editorTabSize, editorIndentTabs, editorRenderWhitespace])

  // Replace editor content when version bumps (external disk reload)
  useEffect(() => {
    if (version === undefined || !viewRef.current) return
    const view = viewRef.current
    const currentDoc = view.state.doc.toString()
    if (currentDoc !== contentRef.current) {
      suppressOnChange.current = true
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: contentRef.current }
      })
      suppressOnChange.current = false
    }
  }, [version])

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />
}
