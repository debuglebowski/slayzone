import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  X,
  Import,
  LayoutGrid,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Camera,
  Bug,
  Sun,
  Moon,
  PaintbrushVertical,
  Keyboard,
  Puzzle,
  Lock,
  Unlock
} from 'lucide-react'
import { track } from '@slayzone/telemetry/client'
import {
  IconButton,
  Input,
  cn,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  withShortcut
} from '@slayzone/ui'
import type { BrowserTab } from '../shared'
import type { TaskUrlEntry } from './BrowserPanel.types'
import type { BrowserTabPlaceholderHandle } from './BrowserTabPlaceholder'
import { EXTENSIONS_MANAGER_ENABLED } from './BrowserPanel.constants'

interface BrowserToolbarProps {
  activeLocked: boolean
  findMode: boolean
  activeViewUrl: string
  activeTab: BrowserTab | null
  toggleActiveLock: () => void
  findInputRef: React.RefObject<HTMLInputElement | null>
  findText: string
  handleFindTextChange: (text: string) => void
  findNext: (forward: boolean) => void
  closeFindMode: () => void
  findResult: { active: number; total: number } | null
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  extensionsManagerOpen: boolean
  multiDeviceMode: boolean
  activeActions: BrowserTabPlaceholderHandle['actions'] | undefined
  setReloadTrigger: React.Dispatch<React.SetStateAction<number>>
  setForceReloadTrigger: React.Dispatch<React.SetStateAction<number>>
  urlInputRef: React.RefObject<HTMLInputElement | null>
  inputUrl: string
  setInputUrl: React.Dispatch<React.SetStateAction<string>>
  handleKeyDown: (e: React.KeyboardEvent) => void
  taskId?: string
  importDropdownOpen: boolean
  setImportDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>
  otherTaskUrls: TaskUrlEntry[]
  updateActiveTab: (patch: Partial<BrowserTab>) => void
  toggleMultiDevice: () => void
  canUseDomPicker: boolean
  webviewReady: boolean
  isPickingElement: boolean
  handlePickElement: () => void
  elementPickerShortcut: string | null
  onScreenshot?: (viewId: string) => void
  activeViewId: string | null
  devToolsOpen: boolean
  toggleDevTools: () => void
  cycleTheme: () => void
  captureShortcuts: boolean
  toggleCaptureShortcuts: () => void
  handleToggleExtensionsManager: () => void
}

export function BrowserToolbar({
  activeLocked,
  findMode,
  activeViewUrl,
  activeTab,
  toggleActiveLock,
  findInputRef,
  findText,
  handleFindTextChange,
  findNext,
  closeFindMode,
  findResult,
  canGoBack,
  canGoForward,
  isLoading,
  extensionsManagerOpen,
  multiDeviceMode,
  activeActions,
  setReloadTrigger,
  setForceReloadTrigger,
  urlInputRef,
  inputUrl,
  setInputUrl,
  handleKeyDown,
  taskId,
  importDropdownOpen,
  setImportDropdownOpen,
  otherTaskUrls,
  updateActiveTab,
  toggleMultiDevice,
  canUseDomPicker,
  webviewReady,
  isPickingElement,
  handlePickElement,
  elementPickerShortcut,
  onScreenshot,
  activeViewId,
  devToolsOpen,
  toggleDevTools,
  cycleTheme,
  captureShortcuts,
  toggleCaptureShortcuts,
  handleToggleExtensionsManager
}: BrowserToolbarProps) {
  return (
    <div className="shrink-0 p-2 border-b flex items-center gap-1 relative">
      {activeLocked && !findMode && (
        <div
          data-testid="browser-agent-lock-banner"
          data-locked="true"
          className="absolute inset-2 z-10 rounded-md border border-amber-500/60 bg-background overflow-hidden"
        >
          <div className="absolute inset-0 bg-amber-500/10 pointer-events-none" />
          <div className="relative h-full flex items-center gap-2 px-2 text-sm text-amber-600 dark:text-amber-400 min-w-0">
            <Lock className="size-3.5 shrink-0" />
            <span className="font-medium shrink-0">Browser controlled by agent</span>
            <span className="truncate text-xs opacity-70 font-mono">
              {activeViewUrl || activeTab?.url || ''}
            </span>
            <button
              type="button"
              data-testid="browser-agent-lock-toggle"
              data-locked="true"
              onClick={toggleActiveLock}
              className="ml-auto shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-500"
              aria-label="Unlock tab (resume user input)"
            >
              <Unlock className="size-3.5" /> Unlock
            </button>
          </div>
        </div>
      )}
      {findMode ? (
        <>
          <Input
            ref={findInputRef}
            value={findText}
            onChange={(e) => handleFindTextChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                findNext(!e.shiftKey)
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                closeFindMode()
              }
            }}
            placeholder="Find in page..."
            className="flex-1 h-7 text-sm"
          />
          {findResult && (
            <span className="text-xs text-muted-foreground whitespace-nowrap px-1">
              {findResult.total > 0 ? `${findResult.active} of ${findResult.total}` : 'No matches'}
            </span>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <IconButton
                  aria-label="Previous match"
                  variant="ghost"
                  size="icon-sm"
                  disabled={!findText}
                  onClick={() => findNext(false)}
                >
                  <ChevronUp className="size-4" />
                </IconButton>
              </span>
            </TooltipTrigger>
            <TooltipContent>Previous match (⇧Enter)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <IconButton
                  aria-label="Next match"
                  variant="ghost"
                  size="icon-sm"
                  disabled={!findText}
                  onClick={() => findNext(true)}
                >
                  <ChevronDown className="size-4" />
                </IconButton>
              </span>
            </TooltipTrigger>
            <TooltipContent>Next match (Enter)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <IconButton
                  aria-label="Close find"
                  variant="ghost"
                  size="icon-sm"
                  onClick={closeFindMode}
                >
                  <X className="size-4" />
                </IconButton>
              </span>
            </TooltipTrigger>
            <TooltipContent>Close (Esc)</TooltipContent>
          </Tooltip>
        </>
      ) : (
        <div className="contents" {...(activeLocked ? { inert: '' as unknown as undefined } : {})}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <IconButton
                  aria-label="Back"
                  variant="ghost"
                  size="icon-sm"
                  disabled={extensionsManagerOpen || !canGoBack || multiDeviceMode}
                  onClick={() => {
                    activeActions?.goBack()
                    track('browser_navigated')
                  }}
                >
                  <ArrowLeft className="size-4" />
                </IconButton>
              </span>
            </TooltipTrigger>
            <TooltipContent>Back</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <IconButton
                  aria-label="Forward"
                  variant="ghost"
                  size="icon-sm"
                  disabled={extensionsManagerOpen || !canGoForward || multiDeviceMode}
                  onClick={() => {
                    activeActions?.goForward()
                    track('browser_navigated')
                  }}
                >
                  <ArrowRight className="size-4" />
                </IconButton>
              </span>
            </TooltipTrigger>
            <TooltipContent>Forward</TooltipContent>
          </Tooltip>
          <ContextMenu>
            <Tooltip>
              <ContextMenuTrigger asChild>
                <TooltipTrigger asChild>
                  <span>
                    <IconButton
                      aria-label={isLoading && !multiDeviceMode ? 'Stop loading' : 'Reload'}
                      variant="ghost"
                      size="icon-sm"
                      disabled={extensionsManagerOpen}
                      onClick={(e) => {
                        if (multiDeviceMode) {
                          if (e.shiftKey) setForceReloadTrigger((r) => r + 1)
                          else setReloadTrigger((r) => r + 1)
                        } else if (isLoading) {
                          activeActions?.stop()
                        } else if (e.shiftKey) {
                          activeActions?.reload(true)
                        } else {
                          activeActions?.reload()
                        }
                        track('browser_navigated')
                      }}
                    >
                      {isLoading && !multiDeviceMode ? (
                        <X className="size-4" />
                      ) : (
                        <RotateCw className="size-4" />
                      )}
                    </IconButton>
                  </span>
                </TooltipTrigger>
              </ContextMenuTrigger>
              <TooltipContent>
                {isLoading && !multiDeviceMode ? 'Stop loading' : 'Reload'}
              </TooltipContent>
            </Tooltip>
            <ContextMenuContent>
              <ContextMenuItem
                onClick={() => {
                  if (multiDeviceMode) setReloadTrigger((r) => r + 1)
                  else activeActions?.reload()
                }}
              >
                Reload
                <ContextMenuShortcut>⌘R</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  if (multiDeviceMode) setForceReloadTrigger((r) => r + 1)
                  else activeActions?.reload(true)
                }}
              >
                Hard Reload
                <ContextMenuShortcut>⇧⌘R</ContextMenuShortcut>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>

          <Input
            ref={urlInputRef}
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter URL..."
            disabled={extensionsManagerOpen}
            className="flex-1 h-7 text-sm"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn(!activeTab?.agentTouched && 'invisible pointer-events-none')}>
                <IconButton
                  aria-label="Lock tab (block user input, agent unaffected)"
                  data-testid="browser-agent-lock-toggle"
                  data-locked="false"
                  variant="ghost"
                  size="icon-sm"
                  disabled={extensionsManagerOpen || !activeTab?.agentTouched}
                  onClick={toggleActiveLock}
                  tabIndex={activeTab?.agentTouched ? 0 : -1}
                >
                  <Unlock className="size-4" />
                </IconButton>
              </span>
            </TooltipTrigger>
            <TooltipContent>Agent controlled this tab. Click to lock user input.</TooltipContent>
          </Tooltip>

          {taskId && (
            <DropdownMenu open={importDropdownOpen} onOpenChange={setImportDropdownOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <DropdownMenuTrigger asChild>
                      <IconButton
                        aria-label="Import URL from another task"
                        variant="ghost"
                        size="icon-sm"
                        disabled={extensionsManagerOpen}
                      >
                        <Import className="size-4" />
                      </IconButton>
                    </DropdownMenuTrigger>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Import URL from another task</TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="end"
                className="max-h-64 w-auto max-w-[50vw] overflow-y-auto"
              >
                {otherTaskUrls.length === 0 ? (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">
                    No URLs from other project tasks
                  </div>
                ) : (
                  otherTaskUrls.map((entry, idx) => (
                    <DropdownMenuItem
                      key={`${entry.taskId}-${idx}`}
                      onClick={() => {
                        setInputUrl(entry.url)
                        updateActiveTab({ url: entry.url })
                        if (!multiDeviceMode) {
                          activeActions?.navigate(entry.url)
                        }
                      }}
                      className="flex flex-col items-start gap-0.5"
                    >
                      <span className="text-xs text-muted-foreground truncate w-full">
                        {entry.taskTitle}
                      </span>
                      <span className="text-sm truncate w-full">{entry.url}</span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <IconButton
                  aria-label={multiDeviceMode ? 'Exit responsive preview' : 'Responsive preview'}
                  variant="ghost"
                  size="icon-sm"
                  disabled={extensionsManagerOpen}
                  className={cn(multiDeviceMode && 'text-blue-500 bg-blue-500/10')}
                  onClick={toggleMultiDevice}
                >
                  <LayoutGrid className="size-4" />
                </IconButton>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {multiDeviceMode ? 'Exit responsive preview' : 'Responsive preview'}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <IconButton
                  aria-label="Pick element"
                  data-testid="browser-pick-element"
                  variant="ghost"
                  size="icon-sm"
                  disabled={
                    extensionsManagerOpen || !canUseDomPicker || multiDeviceMode || !webviewReady
                  }
                  className={cn(
                    isPickingElement && 'text-amber-600 bg-amber-500/15 hover:bg-amber-500/20'
                  )}
                  onClick={handlePickElement}
                >
                  <Crosshair className="size-4" />
                </IconButton>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {!canUseDomPicker
                ? 'Open terminal panel to pick element'
                : isPickingElement
                  ? 'Element picker active (click again to exit)'
                  : withShortcut('Pick element', elementPickerShortcut)}
            </TooltipContent>
          </Tooltip>

          {onScreenshot && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <IconButton
                    aria-label="Screenshot to terminal"
                    data-testid="browser-screenshot"
                    variant="ghost"
                    size="icon-sm"
                    disabled={extensionsManagerOpen || !activeViewId || !webviewReady}
                    onClick={() => activeViewId && onScreenshot(activeViewId)}
                  >
                    <Camera className="size-4" />
                  </IconButton>
                </span>
              </TooltipTrigger>
              <TooltipContent>Screenshot to terminal</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <IconButton
                  aria-label="Toggle Chromium DevTools"
                  data-testid="browser-devtools"
                  variant="ghost"
                  size="icon-sm"
                  disabled={extensionsManagerOpen || multiDeviceMode || !webviewReady}
                  className={cn(devToolsOpen && 'text-blue-500 bg-blue-500/10')}
                  onClick={toggleDevTools}
                >
                  <Bug className="size-4" />
                </IconButton>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {multiDeviceMode
                ? 'DevTools unavailable in responsive preview'
                : 'Toggle Chromium DevTools'}
            </TooltipContent>
          </Tooltip>

          {(() => {
            const themeMode = activeTab?.themeMode ?? 'system'
            const ThemeIcon =
              themeMode === 'dark' ? Moon : themeMode === 'light' ? Sun : PaintbrushVertical
            const themeLabel =
              themeMode === 'dark'
                ? 'Dark (forced)'
                : themeMode === 'light'
                  ? 'Light (forced)'
                  : 'System theme'
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <IconButton
                      aria-label={themeLabel}
                      data-testid="browser-theme-mode"
                      variant="ghost"
                      size="icon-sm"
                      disabled={extensionsManagerOpen || multiDeviceMode || !webviewReady}
                      className={cn(
                        themeMode === 'dark' && 'text-blue-400 bg-blue-500/10',
                        themeMode === 'light' && 'text-amber-400 bg-amber-500/10'
                      )}
                      onClick={cycleTheme}
                    >
                      <ThemeIcon className="size-4" />
                    </IconButton>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {multiDeviceMode
                    ? 'Theme unavailable in responsive preview'
                    : `${themeLabel} — click to cycle`}
                </TooltipContent>
              </Tooltip>
            )
          })()}

          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <IconButton
                  aria-label="Keyboard passthrough"
                  data-testid="browser-keyboard-passthrough"
                  variant="ghost"
                  size="icon-sm"
                  disabled={extensionsManagerOpen || multiDeviceMode || !webviewReady}
                  className={cn(captureShortcuts && 'text-green-500 bg-green-500/10')}
                  onClick={toggleCaptureShortcuts}
                >
                  <Keyboard className="size-4" />
                </IconButton>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {captureShortcuts ? 'Webpage shortcuts enabled' : 'Webpage shortcuts disabled'}
            </TooltipContent>
          </Tooltip>

          {EXTENSIONS_MANAGER_ENABLED && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <IconButton
                    aria-label="Extensions"
                    variant="ghost"
                    size="icon-sm"
                    aria-pressed={extensionsManagerOpen}
                    className={cn(extensionsManagerOpen && 'text-blue-500 bg-blue-500/10')}
                    onClick={handleToggleExtensionsManager}
                  >
                    <Puzzle className="size-4" />
                  </IconButton>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {extensionsManagerOpen ? 'Close extensions manager' : 'Extensions'}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  )
}
