import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { ListItemMove } from './list-item-move'
import { useEffect, type MutableRefObject } from 'react'
import { cn } from '@slayzone/ui'

export type { Editor }

interface RichTextEditorProps {
  value: string
  onChange: (html: string) => void
  onBlur?: () => void
  placeholder?: string
  className?: string
  minHeight?: string
  maxHeight?: string
  testId?: string
  autoFocus?: boolean
  editorRef?: MutableRefObject<Editor | null>
  onReady?: (editor: Editor) => void
}

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
  editorRef,
  onReady
}: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // Disable built-in link - we use our own configured Link extension
        link: false
      }),
      Placeholder.configure({
        placeholder
      }),
      Link.configure({
        openOnClick: false,
        autolink: true
      }),
      TaskList,
      TaskItem.configure({
        nested: true
      }),
      ListItemMove
    ],
    content: value,
    autofocus: autoFocus ? 'end' : false,
    onCreate: ({ editor }) => {
      onReady?.(editor)
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML())
    },
    onBlur: () => {
      onBlur?.()
    },
    editorProps: {
      attributes: {
        class: 'prose prose-sm dark:prose-invert max-w-none focus:outline-none'
      },
      handleKeyDown: (view, event) => {
        if (event.key === 'Escape') {
          view.dom.blur()
          return true
        }
        return false
      }
    }
  })

  // Expose editor instance
  useEffect(() => {
    if (editorRef) editorRef.current = editor
  }, [editor, editorRef])

  // Sync external value changes
  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value)
    }
  }, [value, editor])

  return (
    <div
      data-testid={testId}
      className={cn('w-full h-full flex flex-col', className)}
      style={{ minHeight, maxHeight }}
    >
      <EditorContent editor={editor} className="flex-1 overflow-y-auto" />
    </div>
  )
}
