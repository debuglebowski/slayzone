import { useCallback } from 'react'
import { editorViewCtx } from '@milkdown/core'
import { callCommand } from '@milkdown/utils'
import { cn } from '@slayzone/ui'
import type { RichTextEditorProps } from './rich-text-editor.types'
import { buildEditorThemeStyle } from './rich-text-editor.utils'
import { useEditorSetup } from './use-editor-setup'
import { useClickToFocus } from './use-click-to-focus'
import { useEditorSearch } from './use-editor-search'
import { EditorToolbar } from './EditorToolbar'
import { ArtifactPicker } from './ArtifactPicker'

export type { Editor } from '@milkdown/core'
export { getEditorViewDOM } from './rich-text-editor.utils'

export function RichTextEditor({
  value,
  onChange,
  onBlur,
  placeholder = '',
  className,
  minHeight,
  maxHeight,
  testId,
  autoFocus,
  editorRef: externalEditorRef,
  onReady,
  variant = 'page',
  readability,
  width,
  fontFamily,
  checkedHighlight,
  showToolbar,
  spellcheck,
  themeColors,
  artifacts,
  onArtifactClick,
  searchQuery = '',
  searchActiveIndex = 0,
  searchMatchCase = false,
  searchRegex = false,
  onSearchMatchCountChange,
  onUploadImages,
  frontmatter,
  htmlResolveSrc,
  htmlOnLinkClick,
  onSave
}: RichTextEditorProps) {
  const {
    containerRef,
    editorInstanceRef,
    editorReady,
    formatState,
    mentionState,
    setMentionState,
    insertArtifactLinkRef,
    artifactsRef
  } = useEditorSetup({
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
  })

  const rootRef = useClickToFocus(editorInstanceRef, editorReady)

  useEditorSearch(
    editorInstanceRef,
    editorReady,
    searchQuery,
    searchActiveIndex,
    searchMatchCase,
    searchRegex
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleCommand = useCallback(
    (cmdKey: any) => {
      editorInstanceRef.current?.action(callCommand(cmdKey))
    },
    [editorInstanceRef]
  )

  const themeStyle = buildEditorThemeStyle(themeColors, minHeight, maxHeight)

  return (
    <div
      data-testid={testId}
      className={cn('mk-doc', className)}
      data-variant={variant}
      data-readability={readability}
      data-width={width}
      data-font={fontFamily === 'mono' ? 'mono' : undefined}
      data-checked-highlight={checkedHighlight ? 'true' : undefined}
      data-themed={themeColors ? 'true' : undefined}
      style={themeStyle}
      spellCheck={spellcheck !== false}
      ref={rootRef}
    >
      {showToolbar && editorReady && (
        <EditorToolbar formatState={formatState} onCommand={handleCommand} />
      )}
      <div ref={containerRef} className="mk-doc-scroll" />
      {mentionState?.active &&
        mentionState.coords &&
        artifactsRef.current &&
        artifactsRef.current.length > 0 && (
          <ArtifactPicker
            items={artifactsRef.current}
            query={mentionState.query}
            coords={mentionState.coords}
            onSelect={(item) => {
              const editor = editorInstanceRef.current
              if (editor) {
                const view = editor.ctx.get(editorViewCtx)
                insertArtifactLinkRef.current?.(view, item.id, item.title)
              }
            }}
            onClose={() => setMentionState(null)}
          />
        )}
    </div>
  )
}
