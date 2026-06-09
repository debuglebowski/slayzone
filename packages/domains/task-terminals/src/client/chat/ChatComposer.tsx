import { type Dispatch, type RefObject, type SetStateAction } from 'react'
import { ArrowUp, Square, X as XIcon, RotateCcw, Filter } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import {
  cn,
  AgentModePill,
  AgentModelPill,
  AgentEffortPill,
  AgentCollaborationPill,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Switch,
  type AppearanceSettings
} from '@slayzone/ui'
import {
  chatModesForMode,
  modelsForMode,
  modelSupportsEffortForMode,
  modeSupportsCollaboration,
  modeSupportsFastMode
} from '@slayzone/terminal/shared'
import type { QueuedChatMessage } from '@slayzone/terminal/shared'
import { type ArtifactRef, type UseImagePasteDropReturn } from '@slayzone/editor/hooks'
import { AutocompleteMenu } from './autocomplete/AutocompleteMenu'
import type { useAutocomplete } from './autocomplete/useAutocomplete'
import type { useChatMode } from './useChatMode'
import type { useChatModel } from './useChatModel'
import type { useChatEffort } from './useChatEffort'
import type { useChatCollaboration } from './useChatCollaboration'
import type { useChatFastMode } from './useChatFastMode'

type ModeApi = ReturnType<typeof useChatMode>
type ModelApi = ReturnType<typeof useChatModel>
type EffortApi = ReturnType<typeof useChatEffort>
type CollaborationApi = ReturnType<typeof useChatCollaboration>
type FastModeApi = ReturnType<typeof useChatFastMode>

export interface ChatComposerProps {
  appearance: AppearanceSettings
  finalOnly: boolean
  inFlight: boolean
  mode: string

  // Composer state + actions
  queuedMessages: QueuedChatMessage[]
  removeQueue: (id: string) => Promise<void>
  attachments: ArtifactRef[]
  setAttachments: Dispatch<SetStateAction<ArtifactRef[]>>
  imagePasteDrop: UseImagePasteDropReturn
  autocomplete: ReturnType<typeof useAutocomplete>
  textareaRef: RefObject<HTMLTextAreaElement | null>
  draft: string
  setDraft: Dispatch<SetStateAction<string>>
  setCursorPos: Dispatch<SetStateAction<number>>
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  handleSend: () => void | Promise<void>
  handleStop: () => void | Promise<void>

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
  chatModel: ModelApi['chatModel']
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
  appearance,
  finalOnly,
  inFlight,
  mode,
  queuedMessages,
  removeQueue,
  attachments,
  setAttachments,
  imagePasteDrop,
  autocomplete,
  textareaRef,
  draft,
  setDraft,
  setCursorPos,
  onKeyDown,
  handleSend,
  handleStop,
  displaySessionEnded,
  handleRestart,
  restarting,
  handleReset,
  resetting,
  chatMode,
  handleModeChange,
  autoCapability,
  chatModel,
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
  const trpc = useTRPC()
  const settingsSetMutation = useMutation(trpc.settings.set.mutationOptions())
  const composerWidthClass = appearance.chatWidth === 'wide' ? 'max-w-4xl' : 'max-w-2xl'
  return (
    <div className="bg-background px-4 pt-6 pb-1">
      <div className={cn('mx-auto w-full', composerWidthClass)}>
        {queuedMessages.length > 0 && (
          <div className="mb-2">
            <div className="px-1 mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
              Up next · {queuedMessages.length}
            </div>
            <ul className="divide-y divide-border/40 rounded-md border border-border/40 overflow-hidden">
              {queuedMessages.map((msg, i) => (
                <li
                  key={msg.id}
                  className="group flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30"
                >
                  <span className="shrink-0 text-muted-foreground/50 font-mono text-[10px] tabular-nums">
                    {i + 1}.
                  </span>
                  <span className="flex-1 min-w-0 truncate">{msg.send}</span>
                  <button
                    onClick={() => void removeQueue(msg.id)}
                    className="shrink-0 rounded p-0.5 opacity-50 hover:opacity-100 hover:bg-destructive/15 hover:text-destructive transition-colors"
                    aria-label="Cancel queued message"
                    title="Cancel"
                  >
                    <XIcon className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5 px-1">
            {attachments.map((a, i) => (
              <span
                key={`${a.id}-${i}`}
                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                title={a.title}
              >
                <span className="max-w-[160px] truncate">{a.title}</span>
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                  className="rounded p-0.5 hover:bg-destructive/15 hover:text-destructive transition-colors"
                  aria-label="Remove attachment"
                >
                  <XIcon className="size-2.5" />
                </button>
              </span>
            ))}
            {imagePasteDrop.isUploading && (
              <span className="text-[11px] text-muted-foreground/60">uploading…</span>
            )}
          </div>
        )}
        <div
          className={cn(
            'relative flex items-center gap-2 rounded-2xl bg-muted/40 ring-1 ring-border/60 px-3 py-1.5 transition-shadow',
            displaySessionEnded && 'opacity-50 pointer-events-none'
          )}
          onPaste={(e) => {
            const files = imagePasteDrop.extractImageFiles(e.clipboardData)
            if (files.length === 0) return
            e.preventDefault()
            void imagePasteDrop.handleFiles(files)
          }}
        >
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
            placeholder={displaySessionEnded ? 'Session ended' : 'Ask Claude anything…'}
            disabled={displaySessionEnded}
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 max-h-[240px] py-0.5 leading-normal"
          />
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
                (!draft.trim() && attachments.length === 0) ||
                displaySessionEnded ||
                imagePasteDrop.isUploading
              }
              className={cn(
                'shrink-0 size-8 rounded-full flex items-center justify-center transition-colors',
                (draft.trim() || attachments.length > 0) &&
                  !displaySessionEnded &&
                  !imagePasteDrop.isUploading
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
        <div className="flex items-center gap-3 mt-1.5 px-1 text-[10px] text-muted-foreground/60">
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
              <AgentModePill
                mode={chatMode}
                modes={chatModesForMode(mode)}
                onChange={(next) => {
                  handleModeChange(next).catch(() => {
                    /* toast already shown by hook */
                  })
                }}
                disabled={inFlight}
                compact
                variant="text"
                autoCapability={autoCapability}
              />
              {chatModel && (
                <AgentModelPill
                  model={chatModel}
                  models={modelsForMode(mode)}
                  onChange={(next) => {
                    void handleModelChange(next)
                  }}
                  disabled={modelChanging || inFlight}
                  variant="text"
                />
              )}
              {chatModel && modelSupportsEffortForMode(mode, chatModel) && (
                <AgentEffortPill
                  effort={chatEffort}
                  onChange={(next) => {
                    void handleEffortChange(next)
                  }}
                  disabled={effortChanging || fastModeChanging || inFlight}
                  compact
                  variant="text"
                  showFastMode={modeSupportsFastMode(mode)}
                  fastMode={chatFastMode}
                  onFastModeChange={(next) => {
                    void handleFastModeChange(next)
                  }}
                />
              )}
              {modeSupportsCollaboration(mode) && (
                <AgentCollaborationPill
                  collaboration={chatCollaboration}
                  onChange={(next) => {
                    void handleCollaborationChange(next)
                  }}
                  disabled={collaborationChanging || inFlight}
                  compact
                  variant="text"
                />
              )}
              {appearance.chatWidth === 'wide' && (
                <span>
                  {inFlight
                    ? 'Enter to queue · Shift+Enter for newline'
                    : 'Enter to send · Shift+Enter for newline'}
                </span>
              )}
            </>
          )}
          <div className="flex-1" />
          <Popover>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  'flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors',
                  finalOnly
                    ? 'bg-primary/15 text-foreground'
                    : 'hover:bg-muted/60 hover:text-foreground'
                )}
                title="Display options"
              >
                <Filter className="size-3" />
                Display
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-3 space-y-3">
              <DisplayOptionRow
                label="Show tools"
                description="Show all tool calls inline. When off, only user messages + final assistant reply per turn."
                checked={appearance.chatShowTools}
                onCheckedChange={(c) => {
                  settingsSetMutation.mutate({ key: 'chat_show_tools', value: c ? '1' : '0' })
                  window.dispatchEvent(new CustomEvent('sz:settings-changed'))
                }}
              />
              <DisplayOptionRow
                label="Show last message tools"
                description="When tools are hidden, still show tools after the most recent user message."
                checked={appearance.chatShowLastMessageTools}
                disabled={appearance.chatShowTools}
                onCheckedChange={(c) => {
                  settingsSetMutation.mutate({
                    key: 'chat_show_last_message_tools',
                    value: c ? '1' : '0'
                  })
                  window.dispatchEvent(new CustomEvent('sz:settings-changed'))
                }}
              />
              <DisplayOptionRow
                label="File edits opened by default"
                description="Auto-expand Edit and Write tool cards."
                checked={appearance.chatFileEditsOpenByDefault}
                onCheckedChange={(c) => {
                  settingsSetMutation.mutate({
                    key: 'chat_file_edits_open_by_default',
                    value: c ? '1' : '0'
                  })
                  window.dispatchEvent(new CustomEvent('sz:settings-changed'))
                }}
              />
              <DisplayOptionRow
                label="Show message meta"
                description="Per-turn footer with duration, cost, and turn count."
                checked={appearance.chatShowMessageMeta}
                onCheckedChange={(c) => {
                  settingsSetMutation.mutate({ key: 'chat_show_message_meta', value: c ? '1' : '0' })
                  window.dispatchEvent(new CustomEvent('sz:settings-changed'))
                }}
              />
            </PopoverContent>
          </Popover>
          <button
            onClick={() => {
              void handleReset()
            }}
            disabled={resetting}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-md hover:bg-muted/60 hover:text-foreground transition-colors disabled:opacity-50"
            title="Reset chat (kill session and start fresh)"
          >
            <RotateCcw className={cn('size-3', resetting && 'animate-spin')} />
            Reset
          </button>
        </div>
      </div>
    </div>
  )
}

function DisplayOptionRow({
  label,
  description,
  checked,
  disabled,
  onCheckedChange
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (next: boolean) => void
}) {
  return (
    <div className={cn('flex items-start gap-3', disabled && 'opacity-50')}>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">{description}</div>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        className="mt-0.5"
      />
    </div>
  )
}
