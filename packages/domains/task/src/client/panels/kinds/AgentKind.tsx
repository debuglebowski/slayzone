import {
  AlertTriangle,
  ChevronDown,
  Flag,
  Info,
  MoreHorizontal,
  Power,
  Repeat,
  Terminal as TerminalIcon,
  X
} from 'lucide-react'
import type { AgentId } from '@slayzone/terminal-contracts'
import { isChatSupported } from '@slayzone/terminal-contracts'
import {
  getVisibleModes,
  getModeLabel,
  groupAgents,
  isLoopActive,
  LoopModeBanner,
  SlayNudgeBanner
} from '@slayzone/terminal'
import { TerminalContainer, MODE_ICONS } from '@slayzone/task-terminals'
import {
  Button,
  cn,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Input,
  toast,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useShortcutDisplay
} from '@slayzone/ui'
import { WorkspaceDirPicker } from '@slayzone/file-editor/client/WorkspaceDirPicker'
import { useTRPCClient } from '../../trpc'
import { PanelFrame } from '../PanelFrame'
import { useTaskPageContext } from '../TaskPageContext'
import type { PanelKindProps } from './types'

/**
 * The task's main agent pane (`terminal`): the terminal/chat container with its
 * session banners, mode picker, loop controls and menu. Stays mounted while the
 * task tab is hidden (it takes `isActive`); in compact mode it is the whole cell.
 */
export function AgentKind({ panelId }: PanelKindProps): React.JSX.Element {
  const {
    task,
    project,
    isActive,
    shortcutActive,
    compact,
    isResizing,
    effectiveRepoPath,
    mainAgentCwd,
    openDevServerInBrowser,
    panels,
    agent
  } = useTaskPageContext()
  const { containerWidth, resolvedWidths, panelOrderIdx } = panels
  const {
    runsAgentsHere,
    canRunOwnAgents,
    projectRoot,
    chosenFolder,
    projectPathMissing,
    workspaceUnreachable,
    taskPathPending,
    taskPathLocation,
    taskFolderMissing,
    worktreePath,
    baseDir,
    terminalHandles,
    claimedTerminalGroupIds,
    terminalShortcutOwner,
    terminalKey,
    mainTerminal,
    modes,
    terminalFocusRequestId,
    handleTerminalReady,
    handleTerminalFocusRequestHandled,
    isMainTabActive,
    setIsMainTabActive,
    handleQuickOpenFile,
    handleChatOpenArtifact,
    handleChatOpenTask,
    session,
    loop,
    loopConfigured,
    loopModeAvailable,
    setLoopDialogOpen,
    handleLoopConfigChange,
    slayNudge,
    handleModeChange,
    flagsPopoverOpen,
    setFlagsPopoverOpen,
    flagsInputValue,
    setFlagsInputValue,
    handleFlagsSave,
    getProviderFlagsForMode,
    handleSetDefaultFlags,
    handleInjectTitle,
    handleInjectDescription,
    handleCopyHistory,
    handleCopyConversationId,
    handleDoctor,
    projectFolderPickerOpen,
    setProjectFolderPickerOpen
  } = agent
  const {
    sessionIdCommand,
    showSessionBanner,
    showUnavailableBanner,
    detectedSessionId,
    setSessionUnavailableDismissed,
    handleDetectSessionId,
    getConversationIdForMode,
    handleUpdateSessionId,
    handleRestartTerminal,
    handleStopAgent,
    handleResetTerminal,
    handleSwitchSession,
    handleDeleteSession,
    handleTabSessionReset,
    handleTabSessionSwitch,
    handleReattachTerminal,
    handoffMode,
    handleHandoff
  } = session
  const {
    status: loopStatus,
    iteration: loopIteration,
    startLoop,
    pauseLoop,
    resumeLoop,
    stopLoop
  } = loop
  const {
    showBanner: showSlayNudge,
    dismiss: dismissSlayNudge,
    recheck: recheckSlayNudge
  } = slayNudge
  const trpcClient = useTRPCClient()
  const terminalInjectTitleShortcut = useShortcutDisplay('terminal-inject-title')
  const terminalInjectDescShortcut = useShortcutDisplay('terminal-inject-desc')
  const terminalRestartShortcut = useShortcutDisplay('terminal-restart')
  const syncSessionIdShortcut = useShortcutDisplay('sync-session-id')

  return (
    <PanelFrame
      kind="agent"
      panelId={panelId}
      chrome={!compact}
      className="min-w-0 overflow-hidden flex flex-col"
      style={
        compact
          ? { flex: 1 }
          : containerWidth > 0
            ? { width: resolvedWidths[panelId], order: panelOrderIdx[panelId] ?? 0 }
            : { flex: 1, order: panelOrderIdx[panelId] ?? 0 }
      }
      replacement={
        !runsAgentsHere && !canRunOwnAgents ? (
          // A shared task you may only view (T-100): its agents and terminals are
          // the people's running them, on their own computers — never shown here.
          <div
            className="flex h-full w-full items-center justify-center p-6"
            data-testid="agent-pane-not-yours"
          >
            <div className="max-w-sm space-y-2 text-center">
              <TerminalIcon className="mx-auto size-10 text-muted-foreground/60" />
              <div className="text-sm font-medium text-muted-foreground">
                You can view this task
              </div>
              <div className="text-xs text-muted-foreground/70">
                To run agents on it from your own computer, ask for edit access.
              </div>
            </div>
          </div>
        ) : undefined
      }
    >
      <>
        {projectPathMissing && projectRoot && (
          <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <span className="text-sm text-amber-500">
              Project path not found:{' '}
              <code className="bg-amber-500/10 px-1 rounded">{projectRoot}</code>
            </span>
          </div>
        )}
        {(() => {
          const currentConversationId = getConversationIdForMode(task)
          return (
            detectedSessionId &&
            currentConversationId &&
            detectedSessionId !== currentConversationId
          )
        })() && (
          <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <span className="text-sm text-amber-500">
              Session mismatch: terminal using {detectedSessionId}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-6 text-xs"
              onClick={handleUpdateSessionId}
            >
              Update DB
              <kbd className="ml-2 opacity-70" style={{ fontFamily: 'system-ui' }}>
                {syncSessionIdShortcut}
              </kbd>
            </Button>
          </div>
        )}
        {showSessionBanner && (
          <div className="shrink-0 bg-blue-500/10 border-b border-blue-500/20 px-4 py-1.5 flex items-center gap-2">
            <TerminalIcon className="h-3.5 w-3.5 text-blue-500" />
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-xs text-blue-500 cursor-default">
                  {task.agent_id === 'codex'
                    ? 'Session not saved yet — automatic detection after first prompt'
                    : "Session not saved — resume won't work until detected"}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-72">
                {task.agent_id === 'codex' ? (
                  <>
                    Codex creates its saved session after the first prompt. SlayZone captures it
                    automatically. If this remains after a prompt, use "Run /status" to retry
                    detection.
                  </>
                ) : (
                  <>
                    The AI provider's session ID hasn't been captured yet. Without it, closing and
                    reopening this task will start a fresh conversation instead of resuming. Click
                    "Run {sessionIdCommand}" to detect it automatically.
                  </>
                )}
              </TooltipContent>
            </Tooltip>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-6 text-xs"
              onClick={handleDetectSessionId}
            >
              Run {sessionIdCommand}
            </Button>
          </div>
        )}
        {showUnavailableBanner && (
          <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/20 px-4 py-1.5 flex items-center gap-2">
            <Info className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            <span className="text-xs text-amber-500">
              Session ID detection not available for this provider — don't close the tab or resume
              won't work. Providers with resume: Claude Code, Codex, Gemini, Qwen, Copilot
            </span>
            <button
              className="ml-auto text-amber-500 hover:text-amber-400 shrink-0"
              onClick={() => setSessionUnavailableDismissed(task?.id ?? null)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {showSlayNudge && (
          <SlayNudgeBanner
            taskId={task.id}
            projectPath={effectiveRepoPath ?? projectRoot ?? ''}
            projectId={task?.project_id ?? project?.id}
            onDismiss={dismissSlayNudge}
            onSetupComplete={recheckSlayNudge}
          />
        )}
        {/* Terminal + mode bar wrapper */}
        <div className="relative flex-1 min-h-0 overflow-hidden">
          {taskPathPending ? (
            // The task's folder is on its computer: no terminal until it
            // answers — never one started in the project folder instead.
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {taskPathLocation
                ? `This task's folder is ${taskPathLocation} — connect it to start`
                : 'Loading the task folder…'}
            </div>
          ) : taskFolderMissing ? (
            // Its computer answered and holds no folder for it: never
            // the project folder in its place (S7).
            <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
              This task's folder was not found on its computer
            </div>
          ) : mainAgentCwd && !projectPathMissing ? (
            <TerminalContainer
              ref={terminalHandles.ref(panelId)}
              // Groups another agent/terminal panel claims show there, not here.
              groupFilter={
                claimedTerminalGroupIds.length > 0 ? { except: claimedTerminalGroupIds } : undefined
              }
              paused={isResizing}
              key={`${terminalKey}-${task.project_id}-${effectiveRepoPath || ''}-${worktreePath || ''}-${baseDir || ''}`}
              taskId={task.id}
              isTemporary={task.is_temporary}
              isActive={isActive}
              hasShortcutFocus={shortcutActive && terminalShortcutOwner === panelId}
              cwd={mainAgentCwd}
              // Spawn props shared with the terminal-first pane (one
              // derivation — see mainTerminalProps). No conversation
              // hint: the agent's computer resolves the resume at spawn.
              defaultMode={mainTerminal.mode}
              supportsSessionId={mainTerminal.supportsSessionId}
              providerFlags={mainTerminal.providerFlags}
              executionContext={mainTerminal.executionContext}
              focusRequestId={terminalFocusRequestId}
              onStartFresh={handleResetTerminal}
              onReady={handleTerminalReady}
              onRetry={handleRestartTerminal}
              onFocusRequestHandled={handleTerminalFocusRequestHandled}
              onMainTabActiveChange={setIsMainTabActive}
              onOpenUrl={openDevServerInBrowser}
              onOpenFile={handleQuickOpenFile}
              onOpenArtifact={handleChatOpenArtifact}
              onOpenTask={handleChatOpenTask}
              onMainReset={handleResetTerminal}
              onSwitchSession={handleSwitchSession}
              {...(handoffMode ? { onMainHandoff: () => void handleHandoff() } : {})}
              onDeleteSession={handleDeleteSession}
              onTabSessionReset={handleTabSessionReset}
              onTabSessionSwitch={handleTabSessionSwitch}
              overlay={
                isActive && loopConfigured ? (
                  <LoopModeBanner
                    config={task.loop_config!}
                    status={loopStatus}
                    iteration={loopIteration}
                    onStart={startLoop}
                    onPause={pauseLoop}
                    onResume={resumeLoop}
                    onStop={stopLoop}
                    onEditConfig={() => setLoopDialogOpen(true)}
                  />
                ) : undefined
              }
              mainTabContextMenu={
                <>
                  <ContextMenuRadioGroup
                    value={task.agent_id}
                    onValueChange={(value) => {
                      if (modes.some((m) => m.id === value)) handleModeChange(value as AgentId)
                    }}
                  >
                    {(() => {
                      const visibleModes = getVisibleModes(modes, task.agent_id)
                      const { builtin, custom } = groupAgents(visibleModes)
                      const renderItem = (mode: (typeof visibleModes)[number]) => {
                        const ModeIcon = MODE_ICONS[mode.id as AgentId] ?? TerminalIcon
                        return (
                          <ContextMenuRadioItem key={mode.id} value={mode.id}>
                            <span className="flex items-center gap-2">
                              {/* Decorative: the provider logos carry an SVG
                                  <title>, which would name the item twice
                                  ("Codex Codex"). The label says it. */}
                              <span aria-hidden="true" className="flex">
                                <ModeIcon className="size-3.5" />
                              </span>
                              {getModeLabel(mode)}
                            </span>
                          </ContextMenuRadioItem>
                        )
                      }
                      return (
                        <>
                          {builtin.map(renderItem)}
                          {custom.map(renderItem)}
                        </>
                      )
                    })()}
                  </ContextMenuRadioGroup>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => setFlagsPopoverOpen(true)}>
                    <span className="flex items-center gap-2">
                      <Flag className="size-3.5" />
                      Edit flags
                    </span>
                  </ContextMenuItem>
                </>
              }
              mainTabAccessories={
                <div
                  data-testid="agent-trigger"
                  className="flex items-center gap-1"
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <span className="truncate text-sm">
                    {getModeLabel(
                      modes.find((m) => m.id === task.agent_id) ?? {
                        id: task.agent_id,
                        label: task.agent_id
                      }
                    )}
                  </span>
                  <ChevronDown
                    data-testid="agent-dropdown"
                    aria-label="Open provider menu"
                    role="button"
                    className="size-3 cursor-pointer text-muted-foreground hover:text-foreground transition-colors"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      const tab = (e.currentTarget as unknown as HTMLElement).closest(
                        '[data-tab-main="true"]'
                      )
                      if (!tab) return
                      const rect = (
                        e.currentTarget as unknown as HTMLElement
                      ).getBoundingClientRect()
                      tab.dispatchEvent(
                        new MouseEvent('contextmenu', {
                          bubbles: true,
                          cancelable: true,
                          view: window,
                          clientX: rect.left,
                          clientY: rect.bottom
                        })
                      )
                    }}
                  />
                </div>
              }
              rightContent={
                <Tooltip open={!isMainTabActive && !task.is_temporary ? undefined : false}>
                  <TooltipTrigger asChild>
                    <div
                      className={cn(
                        'flex items-center gap-2 transition-opacity',
                        !isMainTabActive && !task.is_temporary && 'opacity-40 pointer-events-none'
                      )}
                    >
                      {loopModeAvailable && task.agent_id !== 'terminal' && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <IconButton
                              variant={loopConfigured ? 'default' : 'ghost'}
                              className="size-7"
                              aria-label="Loop command"
                              onClick={() => {
                                if (isLoopActive(loopStatus)) stopLoop()
                                if (loopConfigured) {
                                  handleLoopConfigChange(null)
                                } else {
                                  setLoopDialogOpen(true)
                                }
                              }}
                            >
                              <Repeat className="size-3.5" />
                            </IconButton>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">Loop command</TooltipContent>
                        </Tooltip>
                      )}

                      {task.agent_id !== 'terminal' && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <IconButton
                              data-testid="agent-power-off"
                              variant="ghost"
                              className="size-7"
                              aria-label="Shut down agent"
                              onClick={() => void handleStopAgent()}
                            >
                              <Power className="size-3.5" />
                            </IconButton>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">Shut down agent</TooltipContent>
                        </Tooltip>
                      )}

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton
                            data-testid="terminal-menu-trigger"
                            variant="ghost"
                            aria-label="Terminal menu"
                            className="size-7"
                          >
                            <MoreHorizontal className="size-3.5" />
                          </IconButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-60">
                          <DropdownMenuItem onClick={handleInjectTitle}>
                            Inject title
                            <span className="ml-auto text-xs text-muted-foreground">
                              {terminalInjectTitleShortcut}
                            </span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void handleInjectDescription()}>
                            Inject description
                            <span className="ml-auto text-xs text-muted-foreground">
                              {terminalInjectDescShortcut}
                            </span>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={handleCopyHistory}>
                            Copy history
                          </DropdownMenuItem>
                          {task.agent_id !== 'terminal' && (
                            <DropdownMenuItem
                              disabled={!getConversationIdForMode(task)}
                              onClick={handleCopyConversationId}
                            >
                              Copy conversation ID
                            </DropdownMenuItem>
                          )}
                          {handoffMode && (
                            <DropdownMenuItem
                              data-testid="terminal-menu-handoff"
                              disabled={!getConversationIdForMode(task)}
                              onClick={() => void handleHandoff()}
                            >
                              {isChatSupported(task.agent_id)
                                ? 'Continue in terminal'
                                : 'Continue in chat'}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={handleReattachTerminal}>
                            Re-attach terminal
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={handleRestartTerminal}>
                            Restart session
                            <span className="ml-auto pl-4 text-xs text-muted-foreground">
                              {terminalRestartShortcut}
                            </span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={handleResetTerminal}>
                            Reset session
                          </DropdownMenuItem>
                          {task.agent_id !== 'terminal' && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => void handleDoctor()}>
                                Doctor
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <Dialog open={flagsPopoverOpen} onOpenChange={setFlagsPopoverOpen}>
                        <DialogContent className="max-w-md">
                          <DialogHeader>
                            <DialogTitle>{`CLI flags for ${task.agent_id}`}</DialogTitle>
                          </DialogHeader>
                          {
                            <div className="space-y-3">
                              <div className="text-xs text-muted-foreground">
                                Passed to the provider on startup (e.g. --no-cache). Overrides
                                defaults in settings.
                              </div>
                              <Input
                                autoFocus
                                value={flagsInputValue}
                                onChange={(e) => setFlagsInputValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault()
                                    void handleFlagsSave(flagsInputValue)
                                    setFlagsPopoverOpen(false)
                                  } else if (e.key === 'Escape') {
                                    e.preventDefault()
                                    setFlagsInputValue(getProviderFlagsForMode(task))
                                    setFlagsPopoverOpen(false)
                                  }
                                }}
                                placeholder="Flags"
                              />
                              <div className="flex gap-2 justify-end">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    void handleSetDefaultFlags()
                                  }}
                                  disabled={task.agent_id === 'terminal'}
                                >
                                  Reset to default
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => {
                                    void handleFlagsSave(flagsInputValue)
                                    setFlagsPopoverOpen(false)
                                  }}
                                >
                                  Save
                                </Button>
                              </div>
                            </div>
                          }
                        </DialogContent>
                      </Dialog>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Switch to Main tab to use these controls</TooltipContent>
                </Tooltip>
              }
            />
          ) : (
            // Three different situations, three different messages.
            // They were one line — "No repository path configured" —
            // which was a false claim in two of the three cases: it
            // told users to set a path they had already set, while the
            // real cause was a probe run against the wrong machine or
            // a computer that was simply offline.
            <div className="h-full flex items-center justify-center text-muted-foreground">
              <div className="text-center p-8">
                {!projectRoot && !effectiveRepoPath && !chosenFolder ? (
                  // A project needs no folder; its agents do, on the
                  // computer this task runs on. Picked here, it is
                  // recorded on that computer (the hub routes by task).
                  <>
                    {project?.placements?.length ? (
                      // It has one, on another computer: only possible
                      // with several, so naming computers is no news.
                      <>
                        <p className="mb-2">This project has no folder on this task’s computer</p>
                        <p className="text-sm">Pick the folder its agents should start in.</p>
                      </>
                    ) : (
                      // No folder anywhere: the desktop app's own words,
                      // unchanged — its users need not know of computers.
                      <>
                        <p className="mb-2">No repository path configured</p>
                        <p className="text-sm">
                          Set a repository path in project settings to use the terminal
                        </p>
                      </>
                    )}
                    <Button
                      size="sm"
                      className="mt-3"
                      data-testid="pick-project-folder"
                      onClick={() => setProjectFolderPickerOpen(true)}
                    >
                      Pick folder
                    </Button>
                    {projectFolderPickerOpen && (
                      <WorkspaceDirPicker
                        open={projectFolderPickerOpen}
                        onOpenChange={setProjectFolderPickerOpen}
                        onSelect={(picked) => {
                          // A refusal (outside that computer's allowed
                          // folders) is the user's to see and act on.
                          trpcClient.workspace.setProjectPath
                            .mutate({
                              taskId: task.id,
                              projectId: task.project_id,
                              path: picked
                            })
                            .catch((err: unknown) =>
                              toast.error("Couldn't use that folder", {
                                description: err instanceof Error ? err.message : String(err)
                              })
                            )
                        }}
                        target={{ taskId: task.id }}
                        title="Select project folder"
                        allowCreate
                      />
                    )}
                  </>
                ) : workspaceUnreachable ? (
                  <>
                    <p className="mb-2">Can’t reach the machine for this task</p>
                    <p className="text-sm">
                      Its computer is offline, so the workspace can’t be opened. The path itself is
                      unchanged.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="mb-2">Folder not found on this task’s machine</p>
                    <p className="text-sm font-mono text-xs">
                      {effectiveRepoPath ?? projectRoot ?? chosenFolder}
                    </p>
                    <p className="text-sm mt-2">
                      It may have moved or been deleted. Pick it again in project settings.
                    </p>
                  </>
                )}
              </div>
            </div>
          )}
          {/* Black cover during a panel resize. The terminal stays
              mounted underneath — preserving active group + focused
              pane — while the `paused` prop skips xterm fit churn. */}
          {isResizing && <div className="absolute inset-0 z-10 bg-black" />}
        </div>
      </>
    </PanelFrame>
  )
}
