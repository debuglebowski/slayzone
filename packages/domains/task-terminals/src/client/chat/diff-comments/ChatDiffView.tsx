import { useMemo } from 'react'
import { DiffView, type ContextLines, type DiffLine, type FileDiff } from '@slayzone/diff-view'
import { useChatView } from '../ChatViewContext'
import { DiffCommentButton } from './DiffCommentButton'

/**
 * Every diff the chat shows (tool cards, files-changed panel). Where the
 * provider takes them, a line can be commented on (`addDiffComment`).
 */
export function ChatDiffView({
  diff,
  contextLines
}: {
  diff: FileDiff
  contextLines?: ContextLines
}) {
  const { addDiffComment } = useChatView()
  const renderLineAction = useMemo(
    () =>
      addDiffComment
        ? (line: DiffLine) => (
            <DiffCommentButton path={diff.path} line={line} onAdd={addDiffComment} />
          )
        : undefined,
    [addDiffComment, diff.path]
  )
  return (
    <DiffView
      diff={diff}
      {...(contextLines ? { contextLines } : {})}
      {...(renderLineAction ? { renderLineAction } : {})}
    />
  )
}
