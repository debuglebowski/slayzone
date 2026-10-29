import {
  forwardRef,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useInsertionEffect,
  useMemo,
  useRef,
  type MutableRefObject
} from 'react'
import { getThemeEditorColors, useTheme } from '@slayzone/ui'
import {
  EditorView,
  lineNumbers,
  highlightActiveLineGutter,
  highlightActiveLine,
  drawSelection,
  dropCursor
} from '@codemirror/view'
import {
  EditorState,
  Compartment,
  StateField,
  StateEffect,
  RangeSetBuilder
} from '@codemirror/state'
import { buildMinimap as buildMinimapExt, cmScrollbarTheme } from './cm-shared-themes'
import { Decoration } from '@codemirror/view'
import { SearchCursor, RegExpCursor } from '@codemirror/search'
import {
  history,
  historyField,
  defaultKeymap,
  historyKeymap,
  indentWithTab
} from '@codemirror/commands'
import { keymap } from '@codemirror/view'
import {
  indentUnit,
  bracketMatching,
  syntaxHighlighting,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap
} from '@codemirror/language'
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
import { buildCodeMirrorTheme } from './codemirror-theme'

function getLanguageByExt(ext: string | undefined) {
  switch (ext?.toLowerCase()) {
    case 'js':
    case 'jsx':
    case 'mjs':
      return javascript()
    case 'ts':
    case 'mts':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
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
    case 'tf':
    case 'tfvars':
      return hcl()
    default:
      return null
  }
}

const MATCH_CLASS = 'cm-artifact-search-match'
const MATCH_ACTIVE_CLASS = 'cm-artifact-search-match-active'

interface SearchState {
  query: string
  activeIndex: number
  matchCase: boolean
  regex: boolean
  matches: Array<{ from: number; to: number }>
}

const setSearchEffect = StateEffect.define<{
  query: string
  activeIndex: number
  matchCase: boolean
  regex: boolean
}>()

function computeMatches(
  state: EditorState,
  query: string,
  matchCase: boolean,
  regex: boolean
): Array<{ from: number; to: number }> {
  if (!query.trim()) return []
  const result: Array<{ from: number; to: number }> = []
  try {
    if (regex) {
      const cursor = new RegExpCursor(state.doc, query, { ignoreCase: !matchCase })
      while (!cursor.next().done) {
        const v = cursor.value
        if (v.to > v.from) result.push({ from: v.from, to: v.to })
      }
    } else {
      const cursor = new SearchCursor(
        state.doc,
        query,
        0,
        state.doc.length,
        matchCase ? undefined : (x: string) => x.toLowerCase()
      )
      while (!cursor.next().done) {
        const v = cursor.value
        if (v.to > v.from) result.push({ from: v.from, to: v.to })
      }
    }
  } catch {
    /* invalid regex */
  }
  return result
}

function buildSearchField() {
  return StateField.define<SearchState>({
    create: () => ({ query: '', activeIndex: 0, matchCase: false, regex: false, matches: [] }),
    update: (value, tr) => {
      let next = value
      let recompute = false
      for (const e of tr.effects) {
        if (e.is(setSearchEffect)) {
          next = {
            ...next,
            query: e.value.query,
            activeIndex: e.value.activeIndex,
            matchCase: e.value.matchCase,
            regex: e.value.regex
          }
          recompute = true
        }
      }
      if (tr.docChanged) recompute = true
      if (!recompute) return next
      const matches = computeMatches(tr.state, next.query, next.matchCase, next.regex)
      return { ...next, matches }
    }
  })
}

function searchDecorations(field: StateField<SearchState>) {
  return EditorView.decorations.compute([field], (state) => {
    const s = state.field(field)
    if (s.matches.length === 0) return Decoration.none
    const builder = new RangeSetBuilder<Decoration>()
    const activeMod = ((s.activeIndex % s.matches.length) + s.matches.length) % s.matches.length
    for (let i = 0; i < s.matches.length; i++) {
      const r = s.matches[i]
      const cls = i === activeMod ? `${MATCH_CLASS} ${MATCH_ACTIVE_CLASS}` : MATCH_CLASS
      builder.add(r.from, r.to, Decoration.mark({ class: cls }))
    }
    return builder.finish()
  })
}

export interface SearchableCodeViewProps {
  value: string
  onChange: (value: string) => void
  fileExt?: string
  /** Bump to replace editor content from external source (e.g. disk reload) */
  version?: number
  searchQuery?: string
  searchActiveIndex?: number
  searchMatchCase?: boolean
  searchRegex?: boolean
  onSearchMatchCountChange?: (count: number) => void
  fontSize?: number
  placeholder?: string
  minimap?: boolean
  viewHandleRef?: MutableRefObject<EditorView | null>
}

export interface SearchableCodeViewHandle {
  focusLine: (line: number) => void
}

export const SearchableCodeView = forwardRef<SearchableCodeViewHandle, SearchableCodeViewProps>(
  function SearchableCodeView(
    {
      value,
      onChange,
      fileExt,
      version,
      searchQuery = '',
      searchActiveIndex = 0,
      searchMatchCase = false,
      searchRegex = false,
      onSearchMatchCountChange,
      fontSize = 12,
      placeholder,
      minimap,
      viewHandleRef
    },
    ref
  ) {
    const { editorThemeId, contentVariant } = useTheme()
    const themeExt = useMemo(
      () =>
        buildCodeMirrorTheme(
          getThemeEditorColors(editorThemeId, contentVariant),
          contentVariant === 'dark'
        ),
      [editorThemeId, contentVariant]
    )
    const sizeTheme = useMemo(
      () =>
        EditorView.theme({
          '&': { height: '100%', fontSize: `${fontSize}px` },
          '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
        }),
      [fontSize]
    )

    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const searchFieldRef = useRef<StateField<SearchState> | null>(null)
    const onChangeRef = useRef(onChange)
    const onMatchCountRef = useRef(onSearchMatchCountChange)
    const contentRef = useRef(value)
    const suppressOnChange = useRef(false)
    // Latest-prop refs for CM listeners/effects; synced at commit, not in render.
    useInsertionEffect(() => {
      onChangeRef.current = onChange
      onMatchCountRef.current = onSearchMatchCountChange
      contentRef.current = value
    })

    const themeComp = useRef(new Compartment())
    const minimapComp = useRef(new Compartment())
    // What the view held when it was last destroyed (tab hidden, or a
    // language/size change), restored on rebuild so caret, selection, undo
    // history and scroll survive. Scroll is recorded while visible: a hidden
    // (display:none) scroller already reads 0 by the time the view is torn down.
    const savedRef = useRef<{ json: unknown; doc: string } | null>(null)
    const scrollRef = useRef<StateEffect<unknown> | null>(null)

    // Values the view is created from, read as of creation without making
    // them re-create it: theme + minimap are reconfigured live via compartments
    // below, value is the initial doc.
    const readInitial = useEffectEvent(() => ({ value, themeExt, minimap }))

    // Create editor on mount / language / size-theme change
    useEffect(() => {
      if (!containerRef.current) return
      const initial = readInitial()

      const searchField = buildSearchField()
      searchFieldRef.current = searchField
      const lang = getLanguageByExt(fileExt)

      const lastReportedCount = { n: -1 }

      const extensions = [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        dropCursor(),
        foldGutter(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        indentUnit.of('  '),
        keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
        themeComp.current.of(initial.themeExt),
        cmScrollbarTheme,
        minimapComp.current.of(initial.minimap ? buildMinimapExt() : []),
        sizeTheme,
        searchField,
        searchDecorations(searchField),
        EditorView.domEventHandlers({
          scroll: (_e, v) => {
            scrollRef.current = v.scrollSnapshot()
          }
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !suppressOnChange.current) {
            onChangeRef.current(update.state.doc.toString())
          }
          const count = update.state.field(searchField).matches.length
          if (count !== lastReportedCount.n) {
            lastReportedCount.n = count
            onMatchCountRef.current?.(count)
          }
        })
      ]
      if (lang) extensions.splice(0, 0, lang)

      // Restore only onto the same text: if the parent's value moved on while
      // the view was gone, start fresh from it, as a first mount does.
      const saved = savedRef.current
      const state =
        saved && saved.doc === initial.value
          ? EditorState.fromJSON(saved.json, { extensions }, { history: historyField })
          : EditorState.create({ doc: initial.value, extensions })
      const view = new EditorView({ state, parent: containerRef.current })
      viewRef.current = view
      if (viewHandleRef) viewHandleRef.current = view
      if (saved && saved.doc === initial.value && scrollRef.current)
        view.dispatch({ effects: scrollRef.current })

      return () => {
        savedRef.current = {
          json: view.state.toJSON({ history: historyField }),
          doc: view.state.doc.toString()
        }
        view.destroy()
        viewRef.current = null
        if (viewHandleRef) viewHandleRef.current = null
        searchFieldRef.current = null
      }
    }, [fileExt, sizeTheme, viewHandleRef])

    // Reconfigure theme at runtime
    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      view.dispatch({ effects: [themeComp.current.reconfigure(themeExt)] })
    }, [themeExt])

    // Reconfigure minimap at runtime
    useEffect(() => {
      const view = viewRef.current
      if (!view) return
      view.dispatch({
        effects: [minimapComp.current.reconfigure(minimap ? buildMinimapExt() : [])]
      })
    }, [minimap])

    // Replace editor content when version bumps
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

    // Push search state into the editor, scroll active match into view
    useEffect(() => {
      const view = viewRef.current
      const field = searchFieldRef.current
      if (!view || !field) return
      view.dispatch({
        effects: setSearchEffect.of({
          query: searchQuery,
          activeIndex: searchActiveIndex,
          matchCase: searchMatchCase,
          regex: searchRegex
        })
      })
      const s = view.state.field(field)
      if (s.matches.length === 0) return
      const activeMod =
        ((searchActiveIndex % s.matches.length) + s.matches.length) % s.matches.length
      const target = s.matches[activeMod]
      if (target) {
        view.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: 'center' }) })
      }
    }, [searchQuery, searchActiveIndex, searchMatchCase, searchRegex])

    useImperativeHandle(
      ref,
      () => ({
        focusLine: (line: number) => {
          const view = viewRef.current
          if (!view) return
          const total = view.state.doc.lines
          const target = Math.max(1, Math.min(total, line))
          const from = view.state.doc.line(target).from
          view.dispatch({
            selection: { anchor: from },
            effects: EditorView.scrollIntoView(from, { y: 'center' })
          })
          view.focus()
        }
      }),
      []
    )

    return (
      <div
        ref={containerRef}
        className="h-full w-full overflow-hidden"
        data-placeholder={placeholder}
      />
    )
  }
)
