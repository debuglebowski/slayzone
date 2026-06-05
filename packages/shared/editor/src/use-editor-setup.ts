import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { history } from '@milkdown/plugin-history'
import { indent } from '@milkdown/plugin-indent'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { replaceAll, $prose } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { createPlaceholderPlugin } from './milkdown-placeholder'
import { listItemMovePlugin } from './milkdown-list-move'
import { escapeBlurPlugin } from './milkdown-escape-blur'
import { taskListPlugin } from './milkdown-task-list'
import { htmlRenderPlugin } from './milkdown-html-render'
import { mermaidRenderPlugin } from './milkdown-mermaid-render'
import { remarkFrontmatterPlugin, frontmatterSchema, frontmatterView } from './milkdown-frontmatter'
import {
  createArtifactLinkPlugin,
  insertArtifactLinkAtCursor,
  type ArtifactMentionState
} from './milkdown-artifact-link'
import { extractImageFilesFromDataTransfer } from './use-image-paste-drop'
import { createSearchHighlightPlugin } from './milkdown-search-highlight'
import type { ArtifactPickerItem } from './ArtifactPicker'
import type { FormatState } from './rich-text-editor.types'
import { emptyFormatState } from './rich-text-editor.constants'
import { readFormatState } from './rich-text-editor.utils'
import { toggleTaskListCommand } from './editor-commands'

type InsertArtifactLink = (
  view: import('@milkdown/prose/view').EditorView,
  artifactId: string,
  artifactTitle: string
) => void

interface UseEditorSetupArgs {
  value: string
  placeholder: string
  autoFocus?: boolean
  frontmatter?: boolean
  editorRef?: MutableRefObject<Editor | null>
  onChange: (markdown: string) => void
  onBlur?: () => void
  onReady?: (editor: Editor) => void
  onSave?: () => void
  htmlResolveSrc?: (src: string) => string
  htmlOnLinkClick?: (resolvedHref: string) => void
  onArtifactClick?: (artifactId: string) => void
  artifacts?: ArtifactPickerItem[]
  onSearchMatchCountChange?: (count: number) => void
  onUploadImages?: (files: File[]) => Promise<Array<{ id: string; title: string }>>
}

interface UseEditorSetupResult {
  containerRef: MutableRefObject<HTMLDivElement | null>
  editorInstanceRef: MutableRefObject<Editor | null>
  editorReady: boolean
  formatState: FormatState
  mentionState: ArtifactMentionState | null
  setMentionState: (state: ArtifactMentionState | null) => void
  insertArtifactLinkRef: MutableRefObject<InsertArtifactLink | null>
  artifactsRef: MutableRefObject<ArtifactPickerItem[] | undefined>
}

/**
 * Creates and configures the Milkdown editor: builds every plugin, wires their
 * callbacks to local React state, runs the create-on-mount effect, and keeps the
 * editor's content in sync with the `value` prop. Owns all editor-internal refs
 * and the reactive states (`editorReady`, `formatState`, `mentionState`).
 */
export function useEditorSetup({
  value,
  placeholder,
  autoFocus,
  frontmatter,
  editorRef: externalEditorRef,
  onChange,
  onBlur,
  onReady,
  onSave,
  htmlResolveSrc,
  htmlOnLinkClick,
  onArtifactClick,
  artifacts,
  onSearchMatchCountChange,
  onUploadImages
}: UseEditorSetupArgs): UseEditorSetupResult {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorInstanceRef = useRef<Editor | null>(null)
  const onChangeRef = useRef(onChange)
  const onBlurRef = useRef(onBlur)
  const onReadyRef = useRef(onReady)
  const contentRef = useRef(value)
  const suppressOnChange = useRef(false)
  const [formatState, setFormatState] = useState<FormatState>(emptyFormatState)
  const [editorReady, setEditorReady] = useState(false)
  const [mentionState, setMentionState] = useState<ArtifactMentionState | null>(null)
  const onArtifactClickRef = useRef(onArtifactClick)
  const artifactsRef = useRef(artifacts)
  const onSearchMatchCountChangeRef = useRef(onSearchMatchCountChange)
  onSearchMatchCountChangeRef.current = onSearchMatchCountChange
  const onUploadImagesRef = useRef(onUploadImages)
  onUploadImagesRef.current = onUploadImages
  const insertArtifactLinkRef = useRef<InsertArtifactLink | null>(null)
  onArtifactClickRef.current = onArtifactClick
  artifactsRef.current = artifacts

  const onSaveRef = useRef(onSave)
  const htmlResolveSrcRef = useRef(htmlResolveSrc)
  const htmlOnLinkClickRef = useRef(htmlOnLinkClick)
  onSaveRef.current = onSave
  htmlResolveSrcRef.current = htmlResolveSrc
  htmlOnLinkClickRef.current = htmlOnLinkClick

  onChangeRef.current = onChange
  onBlurRef.current = onBlur
  onReadyRef.current = onReady

  // Create editor
  useEffect(() => {
    if (!containerRef.current) return

    let prevFormats = emptyFormatState
    const formatStatePlugin = $prose(
      () =>
        new Plugin({
          key: new PluginKey('formatState'),
          view: () => ({
            update: (view) => {
              const next = readFormatState(view.state)
              if (
                next.bold !== prevFormats.bold ||
                next.italic !== prevFormats.italic ||
                next.bulletList !== prevFormats.bulletList ||
                next.orderedList !== prevFormats.orderedList ||
                next.taskList !== prevFormats.taskList
              ) {
                prevFormats = next
                setFormatState(next)
              }
            }
          })
        })
    )

    const blurHandlerPlugin = $prose(
      () =>
        new Plugin({
          key: new PluginKey('blurHandler'),
          props: {
            handleDOMEvents: {
              blur: () => {
                onBlurRef.current?.()
                return false
              }
            }
          }
        })
    )

    const placeholderPlugin = createPlaceholderPlugin(placeholder)

    // Artifact link plugins (only when artifacts prop is provided)
    const artifactPlugins = createArtifactLinkPlugin(
      (artifactId) => onArtifactClickRef.current?.(artifactId),
      (state) => setMentionState(state)
    )
    insertArtifactLinkRef.current = artifactPlugins.insertArtifactLink

    const searchPlugin = createSearchHighlightPlugin({
      onMatchCountChange: (n) => onSearchMatchCountChangeRef.current?.(n)
    })

    const imagePastePlugin = $prose(
      () =>
        new Plugin({
          key: new PluginKey('imagePasteDrop'),
          props: {
            handlePaste: (view, event) => {
              const upload = onUploadImagesRef.current
              if (!upload) return false
              const files = extractImageFilesFromDataTransfer(event.clipboardData)
              if (files.length === 0) return false
              event.preventDefault()
              void upload(files).then((results) => {
                for (const r of results) insertArtifactLinkAtCursor(view, r.id, r.title)
              })
              return true
            },
            handleDrop: (view, event) => {
              const upload = onUploadImagesRef.current
              if (!upload) return false
              const files = extractImageFilesFromDataTransfer(event.dataTransfer)
              if (files.length === 0) return false
              event.preventDefault()
              void upload(files).then((results) => {
                for (const r of results) insertArtifactLinkAtCursor(view, r.id, r.title)
              })
              return true
            }
          }
        })
    )

    const htmlOpts =
      htmlResolveSrcRef.current || htmlOnLinkClickRef.current
        ? {
            ...(htmlResolveSrcRef.current
              ? { resolveSrc: (src: string) => htmlResolveSrcRef.current!(src) }
              : {}),
            ...(htmlOnLinkClickRef.current
              ? { onLinkClick: (href: string) => htmlOnLinkClickRef.current!(href) }
              : {})
          }
        : undefined

    let editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, containerRef.current!)
        ctx.set(defaultValueCtx, contentRef.current)
      })
      .config((ctx) => {
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, prevMarkdown) => {
          if (suppressOnChange.current) return
          if (markdown === prevMarkdown) return
          contentRef.current = markdown
          onChangeRef.current(markdown)
        })
      })
      .use(commonmark)
      .use(gfm)
      .use(htmlRenderPlugin(htmlOpts))
      .use(history)
      .use(indent)
      .use(listener)
      .use(placeholderPlugin)
      .use(listItemMovePlugin)
      .use(escapeBlurPlugin)
      .use(taskListPlugin)
      .use(mermaidRenderPlugin)
      .use(toggleTaskListCommand)
      .use(formatStatePlugin)
      .use(blurHandlerPlugin)
      .use(artifactPlugins.artifactLinkDecoPlugin)
      .use(artifactPlugins.artifactMentionPlugin)
      .use(searchPlugin)
      .use(imagePastePlugin)

    if (frontmatter) {
      editor = editor.use(remarkFrontmatterPlugin).use(frontmatterSchema).use(frontmatterView)
    }

    let saveKeydownTeardown: (() => void) | null = null

    editor
      .create()
      .then((e) => {
        editorInstanceRef.current = e
        if (externalEditorRef) externalEditorRef.current = e

        setEditorReady(true)

        if (autoFocus) {
          const view = e.ctx.get(editorViewCtx)
          view.focus()
        }

        // Cmd+S / Ctrl+S — install on editor DOM only when host opts in
        if (onSaveRef.current) {
          const view = e.ctx.get(editorViewCtx)
          const handler = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 's') {
              event.preventDefault()
              onSaveRef.current?.()
            }
          }
          view.dom.addEventListener('keydown', handler)
          saveKeydownTeardown = () => view.dom.removeEventListener('keydown', handler)
        }

        onReadyRef.current?.(e)
      })
      .catch((err) => {
        console.error('[RichTextEditor] Failed to create editor:', err)
      })

    return () => {
      saveKeydownTeardown?.()
      editor.destroy().catch(() => {})
      editorInstanceRef.current = null
      if (externalEditorRef) externalEditorRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync external value changes
  useEffect(() => {
    const editor = editorInstanceRef.current
    if (!editor || contentRef.current === value) return
    contentRef.current = value
    suppressOnChange.current = true
    try {
      editor.action(replaceAll(value, true))
    } catch {
      // Editor may not be ready yet
    }
    suppressOnChange.current = false
  }, [value])

  return {
    containerRef,
    editorInstanceRef,
    editorReady,
    formatState,
    mentionState,
    setMentionState,
    insertArtifactLinkRef,
    artifactsRef
  }
}
