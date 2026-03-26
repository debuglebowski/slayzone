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
  fontFamily?: 'sans' | 'mono'
  lineSpacing?: 'compact' | 'normal'
  checkedHighlight?: boolean
  showToolbar?: boolean
  spellcheck?: boolean
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
  onReady,
  fontFamily,
  lineSpacing,
  checkedHighlight,
  showToolbar,
  spellcheck
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
        class: 'prose prose-sm dark:prose-invert max-w-none focus:outline-none',
        spellcheck: spellcheck === false ? 'false' : 'true',
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
      className={cn(
        'w-full h-full flex flex-col',
        fontFamily === 'mono' && 'font-mono',
        lineSpacing === 'compact' && 'prose-tight',
        checkedHighlight && 'checked-highlight',
        className
      )}
      style={{ minHeight, maxHeight }}
    >
      {showToolbar && editor && <EditorToolbar editor={editor} />}
      <EditorContent editor={editor} className="flex-1 overflow-y-auto" />
    </div>
  )
}

function EditorToolbar({ editor }: { editor: Editor }) {
  return (
    <div className="flex items-center gap-0.5 border-b border-border/50 px-1 py-1 shrink-0">
      <ToolbarButton
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
        aria-label="Bold"
        title="Bold"
      >
        B
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        aria-label="Italic"
        title="Italic"
      >
        <span className="italic">I</span>
      </ToolbarButton>
      <div className="mx-1 h-4 w-px bg-border/50" />
      <ToolbarButton
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        aria-label="Bullet list"
        title="Bullet list"
      >
        <svg className="size-3.5" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="4" r="1.5" /><circle cx="3" cy="8" r="1.5" /><circle cx="3" cy="12" r="1.5" /><rect x="6" y="3" width="9" height="2" rx="0.5" /><rect x="6" y="7" width="9" height="2" rx="0.5" /><rect x="6" y="11" width="9" height="2" rx="0.5" /></svg>
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        aria-label="Ordered list"
        title="Ordered list"
      >
        <svg className="size-3.5" viewBox="0 0 16 16" fill="currentColor"><text x="1" y="5.5" fontSize="5" fontFamily="sans-serif">1</text><text x="1" y="9.5" fontSize="5" fontFamily="sans-serif">2</text><text x="1" y="13.5" fontSize="5" fontFamily="sans-serif">3</text><rect x="6" y="3" width="9" height="2" rx="0.5" /><rect x="6" y="7" width="9" height="2" rx="0.5" /><rect x="6" y="11" width="9" height="2" rx="0.5" /></svg>
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive('taskList')}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        aria-label="Checkbox list"
        title="Checkbox list"
      >
        <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="2" width="4" height="4" rx="0.75" /><rect x="1" y="6" width="4" height="4" rx="0.75" /><rect x="1" y="10" width="4" height="4" rx="0.75" /><path d="M2 8.5 3 9.5 4.5 7.5" strokeLinecap="round" strokeLinejoin="round" /><line x1="7" y1="4" x2="15" y2="4" /><line x1="7" y1="8" x2="15" y2="8" /><line x1="7" y1="12" x2="15" y2="12" /></svg>
      </ToolbarButton>
    </div>
  )
}

function ToolbarButton({
  active,
  onClick,
  children,
  ...props
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center justify-center size-7 rounded text-xs font-semibold transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
      {...props}
    >
      {children}
    </button>
  )
}
