import { type ChangeEvent } from 'react'
import { Lock } from 'lucide-react'
import { Button, cn, DiffView, Label, Textarea } from '@slayzone/ui'
import type { AiConfigItem, SkillValidationState, UpdateAiConfigItemInput } from '../shared'
import type { CliProvider } from '../shared'

interface ContextItemEditorContentProps {
  activeDiffProvider: CliProvider | null
  activeDiffGroupLabel: string | null
  activeDiffDisk: string | null
  item: AiConfigItem
  isLibraryLinked: boolean
  effectiveReadOnly: boolean
  content: string
  setContent: (value: string) => void
  setError: (value: string | null) => void
  save: (patch: Omit<UpdateAiConfigItemInput, 'id'>) => Promise<void>
  error: string | null
  effectiveValidation?: SkillValidationState | null
  fixFrontmatterLabel: string | null
  handleFixFrontmatter: () => Promise<void>
  isJson: boolean
  jsonError: string | null
}

export function ContextItemEditorContent({
  activeDiffProvider,
  activeDiffGroupLabel,
  activeDiffDisk,
  item,
  isLibraryLinked,
  effectiveReadOnly,
  content,
  setContent,
  setError,
  save,
  error,
  effectiveValidation,
  fixFrontmatterLabel,
  handleFixFrontmatter,
  isJson,
  jsonError
}: ContextItemEditorContentProps) {
  return (
    <>
      <div className="flex-1 flex flex-col space-y-1 min-h-0">
        <div className="flex items-center justify-between gap-2">
          <Label className="text-xs">
            {activeDiffGroupLabel ? `Diff — ${activeDiffGroupLabel}` : 'Content'}
          </Label>
          {isLibraryLinked && !activeDiffProvider && (
            <div className="flex items-center gap-1.5 text-[11px] text-amber-500">
              <Lock className="size-3" />
              <span>Open this skill in the library to edit it.</span>
            </div>
          )}
        </div>
        {activeDiffProvider ? (
          activeDiffDisk !== null ? (
            <DiffView
              left={activeDiffDisk}
              right={item.content}
              leftLabel="File"
              rightLabel="Database"
              className="flex-1 min-h-0"
            />
          ) : (
            <div className="flex-1 flex items-center justify-center rounded border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
              File missing. Click Sync to write it.
            </div>
          )
        ) : (
          <Textarea
            data-testid="context-item-editor-content"
            className={cn(
              'flex-1 min-h-48 max-h-none field-sizing-fixed font-mono text-sm resize-none',
              effectiveReadOnly &&
                'opacity-50 cursor-not-allowed focus-visible:ring-0 focus-visible:border-input'
            )}
            placeholder="Write your content here..."
            value={content}
            readOnly={effectiveReadOnly}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
              setContent(e.target.value)
              setError(null)
            }}
            onBlur={(e: ChangeEvent<HTMLTextAreaElement>) => {
              if (effectiveReadOnly) return
              const nextContent = e.currentTarget.value
              setContent(nextContent)
              void save({ content: nextContent })
            }}
          />
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {effectiveValidation && effectiveValidation.status !== 'valid' && (
        <div className="rounded border border-destructive/20 bg-destructive/5 px-2.5 py-2">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs font-medium text-destructive">
              {effectiveValidation.status === 'invalid'
                ? 'Frontmatter is invalid'
                : 'Frontmatter warning'}
            </p>
            {fixFrontmatterLabel && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[11px]"
                data-testid="context-item-editor-fix-frontmatter"
                onClick={() => void handleFixFrontmatter()}
              >
                {fixFrontmatterLabel}
              </Button>
            )}
          </div>
          <div className="mt-1 space-y-0.5">
            {effectiveValidation.issues.map((issue, index) => (
              <p key={`${issue.code}-${index}`} className="text-[11px] text-destructive/90">
                {issue.line ? `Line ${issue.line}: ` : ''}
                {issue.message}
              </p>
            ))}
          </div>
        </div>
      )}

      {isJson && jsonError && (
        <div className="rounded border border-destructive/20 bg-destructive/5 px-2.5 py-2">
          <p className="text-[11px] text-destructive">{jsonError}</p>
        </div>
      )}
      {isJson && !jsonError && content.trim() && (
        <p className="text-[11px] text-green-600 dark:text-green-400">Valid JSON</p>
      )}
    </>
  )
}
