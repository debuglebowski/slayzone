import { cn } from '@slayzone/ui'
import { codexFileChanges, type ChatPrompt, type CodexFileChange } from '@slayzone/terminal/client'
import { useChatView } from '../ChatViewContext'
import { ChatDiffView } from '../diff-comments/ChatDiffView'
import { codexChangeFileDiff } from '../tool-cards/file-diffs'
import {
  CODEX_PERMISSIONS_APPROVAL,
  codexApprovalCommand,
  isCodexCommandApproval,
  isCodexFileApproval
} from './codex-approval-options'

const BOX = 'rounded-md border border-border bg-surface-1 font-mono text-xs overflow-auto max-h-64'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Legacy `applyPatchApproval.fileChanges` (`{path: {type, content | unified_diff, move_path}}`). */
function legacyChanges(input: unknown): CodexFileChange[] {
  const files = isRecord(input) && isRecord(input.fileChanges) ? input.fileChanges : {}
  const out: CodexFileChange[] = []
  for (const [path, c] of Object.entries(files)) {
    if (!isRecord(c)) continue
    if (c.type === 'add' || c.type === 'delete') {
      out.push({ path, kind: c.type, diff: typeof c.content === 'string' ? c.content : '' })
    } else if (c.type === 'update') {
      const moved = typeof c.move_path === 'string' && c.move_path ? c.move_path : undefined
      out.push({
        path: moved ?? path,
        ...(moved ? { movedFrom: path } : {}),
        kind: 'update',
        diff: typeof c.unified_diff === 'string' ? c.unified_diff : ''
      })
    }
  }
  return out
}

/**
 * What a Codex request asks about: the command, the file changes (the item's,
 * from its tool row — the request itself only names the item), the permissions.
 */
export function CodexApprovalPreview({ prompt }: { prompt: ChatPrompt }) {
  const { timeline } = useChatView()
  if (isCodexCommandApproval(prompt.toolName)) {
    return (
      <div className={cn(BOX, 'px-2 py-1.5 flex gap-2')}>
        <span aria-hidden className="text-primary select-none">
          $
        </span>
        <span data-testid="codex-approval-command" className="whitespace-pre-wrap break-all">
          {codexApprovalCommand(prompt.input)}
        </span>
      </div>
    )
  }
  if (isCodexFileApproval(prompt.toolName)) {
    let changes = legacyChanges(prompt.input)
    if (changes.length === 0 && prompt.toolUseId) {
      const tool = timeline.find(
        (it) => it.kind === 'tool' && it.invocation.id === prompt.toolUseId
      )
      if (tool?.kind === 'tool') changes = codexFileChanges(tool.invocation)
    }
    if (changes.length === 0) return null
    return (
      <div className="grid gap-1 max-h-64 overflow-auto rounded-md border border-border">
        {changes.map((change, i) => {
          const diff = codexChangeFileDiff(change)
          return diff ? <ChatDiffView key={`${change.path}:${i}`} diff={diff} /> : null
        })}
      </div>
    )
  }
  if (prompt.toolName === CODEX_PERMISSIONS_APPROVAL) {
    const permissions = isRecord(prompt.input) ? prompt.input.permissions : undefined
    if (permissions === undefined) return null
    return (
      <pre className={cn(BOX, 'px-2 py-1.5 whitespace-pre-wrap break-all')}>
        {JSON.stringify(permissions, null, 2)}
      </pre>
    )
  }
  return null
}
