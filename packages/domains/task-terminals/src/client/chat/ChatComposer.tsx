import { useRef, type ReactNode, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { ArrowUp, Square, Filter, Paperclip, Loader2, Eraser } from 'lucide-react'
import { ChatDisplayOptions } from './ChatDisplayOptions'
import {
  cn,
  AgentModelPill,
  AgentEffortPill,
  AgentCollaborationPill,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  type AppearanceSettings
} from '@slayzone/ui'
import {
  chatCapabilitiesForMode,
  chatProviderForMode,
  modeSupportsCollaboration,
  modeSupportsFastMode
} from '@slayzone/terminal-contracts'
import type {
  ChatAttachment,
  ChatModelsView,
  QueuedChatMessage
} from '@slayzone/terminal-contracts'
import type { UsageSummary } from '@slayzone/terminal/client'
import type { UseChatAttachmentsResult } from './attachments/useChatAttachments'
import { AttachmentChip } from './attachments/AttachmentChip'
import { ChatQueueList, type ChatQueueListProps } from './ChatQueueList'
import { AutocompleteMenu } from './autocomplete/AutocompleteMenu'
import { ContextMeter } from './ContextMeter'
import { PromptHistorySearch } from './PromptHistorySearch'
import type { useAutocomplete } from './autocomplete/useAutocomplete'
import type { useChatMode } from './useChatMode'
import type { useChatModel } from './useChatModel'
import type { useChatEffort } from './useChatEffort'
import type { useChatCollaboration } from './useChatCollaboration'
import type { useChatFastMode } from './useChatFastMode'
import type { useChatDefaults } from './useChatDefaults'
import { ChatPermissionMode } from './ChatPermissionMode'

type ModeApi = ReturnType<typeof useChatMode>
type ModelApi = ReturnType<typeof useChatModel>
type EffortApi = ReturnType<typeof useChatEffort>
type CollaborationApi = ReturnType<typeof useChatCollaboration>
type FastModeApi = ReturnType<typeof useChatFastMode>

export interface ChatComposerProps {
  backgroundJobs?: ReactNode
  pendingMessages?: ReactNode
  compact?: boolean
  hasPlanReview?: boolean
  appearance: AppearanceSettings
  finalOnly: boolean
  inFlight: boolean
  mode: string

  // Composer state + actions
  queuedMessages: QueuedChatMessage[]
  removeQueue: (id: string) => Promise<void>
  /** Edit / reorder / send-now for queued messages (see `ChatQueueList`). */
  queueApi: Omit<ChatQueueListProps, 'items' | 'onRemove'>
  attachments: ChatAttachment[]
  setAttachments: Dispatch<SetStateAction<ChatAttachment[]>>
  /** Picking, pasting and dropping files (see `useChatAttachments`). */
  attachmentsApi: UseChatAttachmentsResult
  autocomplete: ReturnType<typeof useAutocomplete>
  textareaRef: RefObject<HTMLTextAreaElement | null>
  draft: string
  setDraft: Dispatch<SetStateAction<string>>
  /** Ghost text after a parked `/name ` (the command's argument hint); null = none. */
  argumentHint?: string | null
  setCursorPos: Dispatch<SetStateAction<number>>
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  handleSend: () => void | Promise<void>
  handleStop: () => void | Promise<void>
  /** Ctrl+R prompt-history search state (see useChatComposer). */
  historySearch: {
    open: boolean
    entries: string[]
    pick: (text: string) => void
    close: () => void
  }
  /** Context size + session cost the provider reported; null → meter hidden. */
  usage: UsageSummary | null

  // Session lifecycle
  displaySessionEnded: boolean
  handleRestart: () => void | Promise<void>
  restarting: boolean
  handleReset: () => void | Promise<void>
  resetting: boolean

  // Mode / model / effort / collaboration / fast-mode pills
  chatMode: ModeApi['chatMode']
  handleModeChange: ModeApi['handleModeChange']
  autoCapability: ModeApi['autoCapability']
  /** The provider's default mode / model / effort (`useChatDefaults`). */
  chatDefaults?: ReturnType<typeof useChatDefaults>
  chatModel: ModelApi['chatModel']
  /** The models (and their effort levels) the provider offers (`useChatModels`). */
  models: ChatModelsView
  handleModelChange: ModelApi['handleModelChange']
  modelChanging: ModelApi['modelChanging']
  chatEffort: EffortApi['chatEffort']
  handleEffortChange: EffortApi['handleEffortChange']
  effortChanging: EffortApi['effortChanging']
  chatCollaboration: CollaborationApi['chatCollaboration']
  handleCollaborationChange: CollaborationApi['handleCollaborationChange']
  collaborationChanging: CollaborationApi['collaborationChanging']
  chatFastMode: FastModeApi['chatFastMode']
  handleFastModeChange: FastModeApi['handleFastModeChange']
  fastModeChanging: FastModeApi['fastModeChanging']
}

/**
 * The composer surface: queued "Up next" list, attachment pills, the autosizing
 * textarea with Stop/Send button, the mode/model/effort/collaboration pill
 * footer, the Display-options popover, and the Reset button.
 *
 * Purely presentational — all state + handlers are threaded in from ChatPanel.
 */
export function ChatComposer({
  backgroundJobs,
  pendingMessages,
  compact = false,
  hasPlanReview = false,
  appearance,
  finalOnly,
  inFlight,
  mode,
  queuedMessages,
  removeQueue,
  queueApi,
  attachments,
  setAttachments,
  attachmentsApi,
  autocomplete,
  textareaRef,
  draft,
  setDraft,
  argumentHint = null,
  setCursorPos,
  onKeyDown,
  handleSend,
  handleStop,
  historySearch,
  usage,
  displaySessionEnded,
  handleRestart,
  restarting,
  handleReset,
  resetting,
  chatMode,
  handleModeChange,
  autoCapability,
  chatDefaults,
  chatModel,
  models,
  handleModelChange,
  modelChanging,
  chatEffort,
  handleEffortChange,
  effortChanging,
  chatCollaboration,
  handleCollaborationChange,
  collaborationChanging,
  chatFastMode,
  handleFastModeChange,
  fastModeChanging
}: ChatComposerProps) {
  // Structured providers share the picker; accepted kinds come from capabilities.
  const canPickFiles = chatCapabilitiesForMode(mode).attachments === 'blocks'
  // Mid-turn the setting pills lock unless the provider applies them live.
  const settingsLocked = inFlight && !chatCapabilitiesForMode(mode).liveSettingsMidTurn
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attaching = attachmentsApi.pending.length > 0
  return (
    <div className={`bg-background pb-1 ${hasPlanReview ? 'pt-0' : 'pt-6'}`}>
      <div data-testid="chat-composer-column" className="mx-auto w-full max-w-[60rem]">
        {backgroundJobs}
        {pendingMessages}
        <ChatQueueList items={queuedMessages} onRemove={removeQueue} {...queueApi} />
        {(attachments.length > 0 || attaching) && (
          <div className="flex flex-wrap gap-1.5 mb-1.5 px-1">
            {attachments.map((a, i) => (
              <AttachmentChip
                key={`${a.artifactId}-${i}`}
                attachment={a}
                onRemove={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
              />
            ))}
            {attachmentsApi.pending.map((p) => (
              <span
                key={p.key}
                className="inline-flex items-center gap-1 rounded-md border border-dashed border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground/70"
              >
                <Loader2 className="size-3 animate-spin" />
                Attaching {p.name}…
              </span>
            ))}
          </div>
        )}
        <div
          className={cn(
            'relative flex items-center gap-2 rounded-2xl bg-muted/40 ring-1 ring-border/60 px-3 py-1.5 transition-shadow',
            displaySessionEnded && 'opacity-50 pointer-events-none'
          )}
          onPaste={attachmentsApi.onPaste}
        >
          {historySearch.open && (
            <PromptHistorySearch
              entries={historySearch.entries}
              onPick={historySearch.pick}
              onClose={historySearch.close}
            />
          )}
          {autocomplete.show && autocomplete.active && (
            <AutocompleteMenu
              active={autocomplete.active}
              selectedIndex={autocomplete.selectedIndex}
              onSelect={(i) => {
                autocomplete.accept(i)
                textareaRef.current?.focus()
              }}
              onHover={autocomplete.setSelectedIndex}
            />
          )}
          {canPickFiles && (
            <>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={displaySessionEnded}
                className="shrink-0 -ml-1 rounded-full p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors disabled:opacity-50"
                title={
                  chatCapabilitiesForMode(mode).attachmentKinds.length === 1
                    ? 'Attach images'
                    : 'Attach files (images, PDFs, text)'
                }
                aria-label="Attach files"
              >
                <Paperclip className="size-4" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept={
                  chatCapabilitiesForMode(mode).attachmentKinds.length === 1 ? 'image/*' : undefined
                }
                multiple
                hidden
                data-testid="chat-attach-input"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? [])
                  // Same file again later must fire `change` again.
                  e.target.value = ''
                  if (files.length > 0) void attachmentsApi.addFiles(files)
                }}
              />
            </>
          )}
          <div className="relative flex-1 min-w-0 flex">
            {argumentHint && (
              <div
                aria-hidden
                data-testid="chat-argument-hint"
                className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre text-sm py-0.5 leading-normal"
              >
                <span className="invisible">{draft}</span>
                <span className="text-muted-foreground/50">{argumentHint}</span>
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                setCursorPos(e.target.selectionStart ?? e.target.value.length)
              }}
              onSelect={(e) => {
                const el = e.currentTarget
                setCursorPos(el.selectionStart ?? el.value.length)
              }}
              onKeyUp={(e) => {
                const el = e.currentTarget
                setCursorPos(el.selectionStart ?? el.value.length)
              }}
              onKeyDown={onKeyDown}
              placeholder={
                displaySessionEnded
                  ? 'Session ended'
                  : `Ask ${chatProviderForMode(mode).agent} anything…`
              }
              disabled={displaySessionEnded}
              rows={1}
              className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 max-h-[240px] py-0.5 leading-normal"
            />
          </div>
          {inFlight ? (
            <button
              onClick={() => {
                void handleStop()
              }}
              disabled={displaySessionEnded}
              className="shrink-0 size-8 rounded-full flex items-center justify-center bg-destructive text-white hover:bg-destructive/90 transition-colors disabled:opacity-50"
              title="Stop generation (Esc)"
              aria-label="Stop generation"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              onClick={() => {
                void handleSend()
              }}
              disabled={
                (!draft.trim() && attachments.length === 0) || displaySessionEnded || attaching
              }
              className={cn(
                'shrink-0 size-8 rounded-full flex items-center justify-center transition-colors',
                (draft.trim() || attachments.length > 0) && !displaySessionEnded && !attaching
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-muted-foreground cursor-not-allowed'
              )}
              title="Send (Enter)"
              aria-label="Send"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
        <div
          className={
            compact && !displaySessionEnded
              ? 'hidden'
              : 'flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 px-1 text-[10px] text-muted-foreground/60 whitespace-nowrap [&>*]:shrink-0'
          }
        >
          {displaySessionEnded ? (
            <button
              type="button"
              onClick={() => {
                void handleRestart()
              }}
              disabled={restarting}
              className="text-destructive hover:underline disabled:opacity-50"
              title="Restart the chat session (preserves history)"
            >
              {restarting ? 'Restarting…' : 'Session ended, click to restart'}
            </button>
          ) : (
            <>
              <ChatPermissionMode
                mode={mode}
                chatMode={chatMode}
                inFlight={inFlight}
                onChange={handleModeChange}
                autoCapability={autoCapability}
                defaultMode={chatDefaults?.defaultMode}
                onSetDefault={chatDefaults?.setDefaultMode}
              />
              {/* Null until hydrated; '' = the provider's default (Codex before it listed models). */}
              {chatModel !== null && (
                <AgentModelPill
                  model={chatModel}
                  models={models.models}
                  emptyLabel="Default"
                  emptyHint={`${chatProviderForMode(mode).product} lists its models once it has started.`}
                  onChange={(next) => {
                    void handleModelChange(next)
                  }}
                  disabled={modelChanging || settingsLocked}
                  variant="text"
                  defaultModel={chatDefaults?.defaultModel}
                  onSetDefault={chatDefaults?.setDefaultModel}
                />
              )}
              {chatModel && models.supportsEffort(chatModel) && (
                <AgentEffortPill
                  effort={chatEffort}
                  {...(models.effortLevels(chatModel)
                    ? { levels: models.effortLevels(chatModel) }
                    : {})}
                  onChange={(next) => {
                    void handleEffortChange(next)
                  }}
                  disabled={effortChanging || fastModeChanging || settingsLocked}
                  compact
                  variant="text"
                  showFastMode={modeSupportsFastMode(mode)}
                  fastMode={chatFastMode}
                  onFastModeChange={(next) => {
                    void handleFastModeChange(next)
                  }}
                  defaultEffort={chatDefaults?.defaultEffort}
                  onSetDefault={chatDefaults?.setDefaultEffort}
                />
              )}
              {modeSupportsCollaboration(mode) && (
                <AgentCollaborationPill
                  collaboration={chatCollaboration}
                  onChange={(next) => {
                    void handleCollaborationChange(next)
                  }}
                  disabled={collaborationChanging || settingsLocked}
                  compact
                  variant="text"
                />
              )}
            </>
          )}
          <div className="flex-1" />
          <ContextMeter summary={usage} />
          <Popover>
            <FooterTip label="Display options">
              <PopoverTrigger asChild>
                <button
                  className={cn(
                    'flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors',
                    finalOnly
                      ? 'bg-primary/15 text-foreground'
                      : 'hover:bg-muted/60 hover:text-foreground'
                  )}
                  aria-label="Display options"
                >
                  <Filter className="size-3" />
                </button>
              </PopoverTrigger>
            </FooterTip>
            <PopoverContent
              align="end"
              className="w-[320px] max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-2"
            >
              <ChatDisplayOptions appearance={appearance} />
            </PopoverContent>
          </Popover>
          <FooterTip label="Reset chat (kill session and start fresh)">
            <button
              onClick={() => {
                void handleReset()
              }}
              disabled={resetting}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md hover:bg-muted/60 hover:text-foreground transition-colors disabled:opacity-50"
              aria-label="Reset chat"
            >
              <Eraser className={cn('size-3', resetting && 'animate-pulse')} />
            </button>
          </FooterTip>
        </div>
      </div>
    </div>
  )
}

/**
 * Tooltip for an icon-only footer control. The trigger is a wrapping span, not the
 * control: a disabled button gets no pointer events, and its tooltip must still show.
 */
function FooterTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}
