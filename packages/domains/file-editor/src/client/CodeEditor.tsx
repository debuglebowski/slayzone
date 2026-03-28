import { useEffect, useMemo, useRef } from 'react'
import { useAppearance } from '@slayzone/settings/client'
import { useTheme } from '@slayzone/settings/client'
import { getEditorThemeById, editorThemes } from '@slayzone/editor'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { keymap, highlightWhitespace } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { buildCodeMirrorTheme } from './codemirror-theme'

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
}

export function CodeEditor({ filePath, content, onChange, onSave, version }: CodeEditorProps) {
  const { theme } = useTheme()
  const {
    editorFontSize, editorWordWrap, editorTabSize, editorIndentTabs, editorRenderWhitespace,
    contentThemeFollowApp, contentThemeDark, contentThemeLight
  } = useAppearance()

  const resolvedThemeId = contentThemeFollowApp
    ? (theme === 'dark' ? contentThemeDark : contentThemeLight)
    : contentThemeDark
  const resolvedVariant = editorThemes.find(t => t.id === resolvedThemeId)?.variant ?? 'dark'
  const cmThemeExt = useMemo(
    () => buildCodeMirrorTheme(getEditorThemeById(resolvedThemeId), resolvedVariant === 'dark'),
    [resolvedThemeId, resolvedVariant]
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
        indentWithTab,
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
