import { type ChangeEvent } from 'react'
import { Trash2 } from 'lucide-react'
import { Button, Input, Label } from '@slayzone/ui'
import type { ContextItemEditorProps } from './ContextItemEditor.types'
import { useContextItemEditorState } from './useContextItemEditorState'
import { ContextItemEditorSync } from './ContextItemEditorSync'
import { ContextItemEditorHeader } from './ContextItemEditorHeader'
import { ContextItemEditorContent } from './ContextItemEditorContent'

export type { ContextItemEditorProps }

export function ContextItemEditor(props: ContextItemEditorProps) {
  const {
    item,
    onDelete,
    onClose,
    readOnly,
    updateInfo,
    onMarketplaceUpdate,
    onUnlink,
    onSyncToDisk,
    onSyncProviderToDisk,
    onPullProviderFromDisk
  } = props

  const {
    provenance,
    isMarketplaceBound,
    isLibraryLinked,
    effectiveReadOnly,
    navigateToMarketplaceEntry,
    navigateToLibrarySkill,
    slug,
    setSlug,
    content,
    setContent,
    saving,
    error,
    setError,
    syncingAll,
    syncingProvider,
    pullingProvider,
    activeDiffProvider,
    setActiveDiffProvider,
    providerGroups,
    isStale,
    activeDiffDisk,
    activeDiffGroupLabel,
    handleSyncAllToDisk,
    handleSyncProvider,
    handlePullProvider,
    anySyncBusy,
    effectiveValidation,
    isJson,
    jsonError,
    fixFrontmatterLabel,
    handleFixFrontmatter,
    save
  } = useContextItemEditorState(props)

  return (
    <div className="flex-1 flex flex-col space-y-3 min-h-0 overflow-y-auto">
      <ContextItemEditorSync
        isStale={isStale}
        providerGroups={providerGroups}
        activeDiffProvider={activeDiffProvider}
        setActiveDiffProvider={setActiveDiffProvider}
        syncingAll={syncingAll}
        syncingProvider={syncingProvider}
        pullingProvider={pullingProvider}
        anySyncBusy={anySyncBusy}
        handleSyncAllToDisk={handleSyncAllToDisk}
        handleSyncProvider={handleSyncProvider}
        handlePullProvider={handlePullProvider}
        onSyncToDisk={onSyncToDisk}
        onSyncProviderToDisk={onSyncProviderToDisk}
        onPullProviderFromDisk={onPullProviderFromDisk}
      />

      <div className="space-y-1">
        <Label className="text-xs">Filename</Label>
        <Input
          data-testid="context-item-editor-slug"
          className={`font-mono text-sm ${effectiveReadOnly ? 'opacity-50 cursor-not-allowed focus-visible:ring-0 focus-visible:border-input' : ''}`}
          placeholder="my-skill.md"
          value={slug}
          readOnly={effectiveReadOnly}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            setSlug(e.target.value)
            setError(null)
          }}
          onBlur={(e: ChangeEvent<HTMLInputElement>) => {
            if (effectiveReadOnly) return
            const nextSlug = e.currentTarget.value
            setSlug(nextSlug)
            void save({ slug: nextSlug })
          }}
        />
      </div>

      <ContextItemEditorHeader
        provenance={provenance}
        isLibraryLinked={isLibraryLinked}
        item={item}
        updateInfo={updateInfo}
        onMarketplaceUpdate={onMarketplaceUpdate}
        onUnlink={onUnlink}
        navigateToMarketplaceEntry={navigateToMarketplaceEntry}
        navigateToLibrarySkill={navigateToLibrarySkill}
      />

      <ContextItemEditorContent
        activeDiffProvider={activeDiffProvider}
        activeDiffGroupLabel={activeDiffGroupLabel}
        activeDiffDisk={activeDiffDisk}
        item={item}
        isLibraryLinked={isLibraryLinked}
        effectiveReadOnly={effectiveReadOnly}
        content={content}
        setContent={setContent}
        setError={setError}
        save={save}
        error={error}
        effectiveValidation={effectiveValidation}
        fixFrontmatterLabel={fixFrontmatterLabel}
        handleFixFrontmatter={handleFixFrontmatter}
        isJson={isJson}
        jsonError={jsonError}
      />

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button size="sm" variant="ghost" onClick={onClose} data-testid="context-item-editor-close">
          Close
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {isMarketplaceBound
              ? 'Read-only (marketplace skill)'
              : readOnly
                ? 'Read-only (library skill)'
                : saving
                  ? 'Saving...'
                  : 'Autosave on blur'}
          </span>
          {!effectiveReadOnly && (
            <Button size="sm" variant="ghost" className="text-destructive" onClick={onDelete}>
              <Trash2 className="mr-1 size-3" />
              Delete
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
