import { useRef, useState } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { Button, Popover, PopoverContent, PopoverTrigger } from '@slayzone/ui'
import type { DiffLine } from '@slayzone/diff-view'
import type { DiffLineComment } from './format'

/** The line number a comment names: the old one for a removed line. */
export function commentLineNo(line: DiffLine): number | null {
  return line.type === 'delete' ? line.oldLineNo : (line.newLineNo ?? line.oldLineNo)
}

/**
 * "Comment on this line": a small button over the line's +/- column (shown on
 * hover), opening a box whose text goes into the composer. Enter adds it,
 * Shift+Enter is a new line, Esc cancels.
 */
export function DiffCommentButton({
  path,
  line,
  onAdd
}: {
  path: string
  line: DiffLine
  onAdd: (comment: DiffLineComment) => void
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  // Added: the composer took focus, so closing must not hand it back to this button.
  const addedRef = useRef(false)
  const lineNo = commentLineNo(line)
  const name = path.split('/').pop() ?? path

  const add = (): void => {
    if (!text.trim()) return
    addedRef.current = true
    onAdd({ path, line, comment: text })
    setText('')
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) addedRef.current = false
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="diff-comment-button"
          aria-label={`Comment on line ${lineNo ?? ''}`.trim()}
          title="Comment on this line — it goes into your next message"
          className="flex size-4 items-center justify-center rounded-sm bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <MessageSquarePlus className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-2"
        onCloseAutoFocus={(e) => {
          if (addedRef.current) e.preventDefault()
        }}
      >
        <div className="mb-1 truncate text-[11px] text-muted-foreground">
          Comment on {name}
          {lineNo != null ? `:${lineNo}` : ''}
          {line.type === 'delete' ? ' (removed line)' : ''}
        </div>
        <textarea
          data-testid="diff-comment-input"
          autoFocus
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              add()
            } else if (e.key === 'Escape') {
              // Not the files panel's Esc (React events bubble out of the portal).
              e.preventDefault()
              e.stopPropagation()
              setOpen(false)
            }
          }}
          placeholder="Your comment goes into your next message"
          className="w-full resize-none rounded-md border border-input bg-transparent px-2 py-1 text-xs dark:bg-input/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <div className="mt-1.5 flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button size="sm" data-testid="diff-comment-add" disabled={!text.trim()} onClick={add}>
            Add to message
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
