import { useRef, useCallback, useState } from 'react'
import { Dialog, DialogContent } from '@slayzone/ui'
import {
  RichTextEditor,
  type Editor,
  type EditorThemeColors,
  type ArtifactPickerItem,
  type LinkOpenTarget
} from '@slayzone/editor'
import { editorViewCtx } from '@milkdown/core'

interface DescriptionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: string
  onChange: (markdown: string) => void
  onSave: () => void
  fontFamily?: 'sans' | 'mono'
  readability?: 'compact' | 'normal'
  width?: 'narrow' | 'wide'
  checkedHighlight?: boolean
  showToolbar?: boolean
  spellcheck?: boolean
  themeColors?: EditorThemeColors
  artifacts?: ArtifactPickerItem[]
  onArtifactClick?: (artifactId: string) => void
  onUploadImages?: (files: File[]) => Promise<Array<{ id: string; title: string }>>
  onOpenLink?: (href: string, target: LinkOpenTarget) => void
}

function getWordCount(editor: Editor | null): number {
  if (!editor) return 0
  try {
    let text = ''
    editor.action((ctx) => {
      text = ctx.get(editorViewCtx).state.doc.textContent
    })
    return text.split(/\s+/).filter(Boolean).length
  } catch {
    return 0
  }
}

export function DescriptionDialog({
  open,
  onOpenChange,
  value,
  onChange,
  onSave,
  fontFamily,
  readability,
  width,
  checkedHighlight,
  showToolbar,
  spellcheck,
  themeColors,
  artifacts,
  onArtifactClick,
  onUploadImages,
  onOpenLink
}: DescriptionDialogProps) {
  const editorRef = useRef<Editor | null>(null)
  const [wordCount, setWordCount] = useState(0)

  const handleChange = useCallback(
    (html: string) => {
      onChange(html)
      setWordCount(getWordCount(editorRef.current))
    },
    [onChange]
  )

  const handleEditorReady = useCallback((editor: Editor) => {
    setWordCount(getWordCount(editor))
  }, [])

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onSave()
        onOpenChange(o)
      }}
    >
      <DialogContent
        className="!w-[80vw] !max-w-[80vw] h-[80vh] p-0 flex flex-col gap-0 overflow-hidden"
        showCloseButton={false}
        aria-labelledby="desc-dialog-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 id="desc-dialog-title" className="text-sm font-medium">
            Description
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground tabular-nums">
              {wordCount} {wordCount === 1 ? 'word' : 'words'}
            </span>
            <kbd className="text-[10px] text-muted-foreground/60 border border-border rounded px-1.5 py-0.5">
              Esc to close
            </kbd>
          </div>
        </div>

        {/* Editor */}
        <RichTextEditor
          value={value}
          onChange={handleChange}
          placeholder="Write your description..."
          className="flex-1 min-h-0"
          testId="task-description-editor-fullscreen"
          autoFocus
          editorRef={editorRef}
          onReady={handleEditorReady}
          fontFamily={fontFamily}
          readability={readability}
          width={width}
          checkedHighlight={checkedHighlight}
          showToolbar={showToolbar}
          spellcheck={spellcheck}
          themeColors={themeColors}
          artifacts={artifacts}
          onArtifactClick={onArtifactClick}
          onUploadImages={onUploadImages}
          onOpenLink={onOpenLink}
        />
      </DialogContent>
    </Dialog>
  )
}
