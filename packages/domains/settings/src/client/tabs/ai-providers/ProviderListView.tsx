import { ChevronRight, Copy, Plus, RefreshCw, CheckCircle2, AlertCircle } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Switch
} from '@slayzone/ui'
import { getVisibleModes, getModeLabel, groupTerminalModes } from '@slayzone/terminal'
import { DETECTION_ENGINES } from '@slayzone/terminal/shared'
import type {
  TerminalMode,
  TerminalModeInfo,
  UpdateTerminalModeInput
} from '@slayzone/terminal/shared'
import type { AiProviderForm } from './useAiProviderForm'

interface ProviderListViewProps {
  modes: TerminalModeInfo[]
  navigateTo: (tab: string) => void
  updateMode: (id: string, updates: UpdateTerminalModeInput) => Promise<TerminalModeInfo | null>
  restoreDefaults: () => Promise<void>
  resetToDefaultState: () => Promise<void>
  defaultTerminalMode: TerminalMode
  onDefaultTerminalModeChange: (mode: TerminalMode) => void
  form: AiProviderForm
}

export function ProviderListView({
  modes,
  navigateTo,
  updateMode,
  restoreDefaults,
  resetToDefaultState,
  defaultTerminalMode,
  onDefaultTerminalModeChange,
  form
}: ProviderListViewProps) {
  const {
    showAddForm,
    setShowAddForm,
    newModeLabel,
    setNewModeLabel,
    newInitialCommand,
    setNewInitialCommand,
    newResumeCommand,
    setNewResumeCommand,
    newDefaultFlags,
    setNewDefaultFlags,
    newDetectionEngine,
    setNewDetectionEngine,
    newPatternWorking,
    setNewPatternWorking,
    newPatternError,
    setNewPatternError,
    duplicateMode,
    handleTest,
    submitNewMode,
    testResults,
    setTestResults,
    testingId
  } = form

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Label className="text-sm font-medium">Default provider</Label>
        <Select
          value={defaultTerminalMode}
          onValueChange={(v) => onDefaultTerminalModeChange(v as TerminalMode)}
        >
          <SelectTrigger className="max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            position="popper"
            align="start"
            className="min-w-[var(--radix-select-trigger-width)] max-h-none"
          >
            {(() => {
              const visibleModes = getVisibleModes(modes, defaultTerminalMode)
              const { builtin, custom } = groupTerminalModes(visibleModes)
              return (
                <>
                  {builtin.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {getModeLabel(m)}
                    </SelectItem>
                  ))}
                  {custom.length > 0 && builtin.length > 0 && <SelectSeparator />}
                  {custom.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {getModeLabel(m)}
                    </SelectItem>
                  ))}
                </>
              )
            })()}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between">
        <Label className="text-base font-semibold">Providers</Label>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={restoreDefaults}>
            Restore defaults
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={resetToDefaultState}
            className="text-destructive hover:text-destructive"
          >
            Reset all
          </Button>
        </div>
      </div>

      <div className="space-y-6">
        {(() => {
          const { builtin, custom } = groupTerminalModes(modes)
          return (
            <>
              {builtin.length > 0 && (
                <div className="space-y-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Built-in
                  </h4>
                  <div className="space-y-2">
                    {builtin.map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        className="flex items-center gap-3 h-11 rounded-lg border px-4 w-full text-left hover:bg-accent/30 transition-colors"
                        onClick={() => navigateTo(`ai-providers/${mode.id}`)}
                      >
                        <div className="size-4 flex items-center justify-center shrink-0">
                          <div className="size-2 rounded-full bg-blue-500" />
                        </div>
                        <span className="text-sm font-medium flex-1">{mode.label}</span>
                        <span className="text-xs text-muted-foreground truncate max-w-[200px] font-mono">
                          {mode.initialCommand}
                        </span>
                        <div
                          className="flex items-center gap-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Label
                            htmlFor={`list-enable-${mode.id}`}
                            className="text-[10px] uppercase text-muted-foreground font-semibold cursor-pointer"
                          >
                            Enabled
                          </Label>
                          <Switch
                            id={`list-enable-${mode.id}`}
                            checked={mode.enabled}
                            onCheckedChange={(checked) =>
                              updateMode(mode.id, { enabled: checked })
                            }
                          />
                        </div>
                        <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {custom.length > 0 && (
                <div className="space-y-3 pt-4 border-t border-border dark:border-border">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Custom
                  </h4>
                  <div className="space-y-2">
                    {custom.map((mode) => (
                      <button
                        key={mode.id}
                        type="button"
                        className="flex items-center gap-3 h-11 rounded-lg border px-4 w-full text-left hover:bg-accent/30 transition-colors"
                        onClick={() => navigateTo(`ai-providers/${mode.id}`)}
                      >
                        <div className="size-4 flex items-center justify-center shrink-0">
                          <div className="size-2 rounded-full bg-blue-500" />
                        </div>
                        <span className="text-sm font-medium flex-1">{mode.label}</span>
                        <span className="text-xs text-muted-foreground truncate max-w-[200px] font-mono">
                          {mode.initialCommand}
                        </span>
                        <div
                          className="flex items-center gap-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Label
                            htmlFor={`list-enable-${mode.id}`}
                            className="text-[10px] uppercase text-muted-foreground font-semibold cursor-pointer"
                          >
                            Enabled
                          </Label>
                          <Switch
                            id={`list-enable-${mode.id}`}
                            checked={mode.enabled}
                            onCheckedChange={(checked) =>
                              updateMode(mode.id, { enabled: checked })
                            }
                          />
                        </div>
                        <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )
        })()}
      </div>

      {!showAddForm ? (
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1 border-dashed"
            onClick={() => setShowAddForm(true)}
          >
            <Plus className="size-3.5 mr-1.5" />
            Add Custom Provider
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="flex-1 border-dashed">
                <Copy className="size-3.5 mr-1.5" />
                Duplicate Provider
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(() => {
                const builtin = modes.filter((m) => m.isBuiltin && m.id !== 'terminal')
                const custom = modes.filter((m) => !m.isBuiltin)
                return (
                  <>
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Built-in
                    </DropdownMenuLabel>
                    {builtin.map((mode) => (
                      <DropdownMenuItem key={mode.id} onClick={() => duplicateMode(mode)}>
                        {mode.label}
                      </DropdownMenuItem>
                    ))}
                    {custom.length > 0 && (
                      <>
                        <DropdownMenuLabel className="text-xs text-muted-foreground mt-4">
                          Custom
                        </DropdownMenuLabel>
                        {custom.map((mode) => (
                          <DropdownMenuItem key={mode.id} onClick={() => duplicateMode(mode)}>
                            {mode.label}
                          </DropdownMenuItem>
                        ))}
                      </>
                    )}
                  </>
                )
              })()}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : (
        <div className="p-4 rounded-lg border border-dashed space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">Add Custom Provider</h4>
            <Button variant="ghost" size="sm" onClick={() => setShowAddForm(false)}>
              Cancel
            </Button>
          </div>
          <div className="space-y-2">
            <Label className="text-xs uppercase text-muted-foreground">Label</Label>
            <Input
              placeholder="My AI"
              value={newModeLabel}
              onChange={(e) => setNewModeLabel(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs uppercase text-muted-foreground">Initial Command</Label>
            <div className="flex items-center gap-2">
              <Input
                className="font-mono text-xs flex-1"
                placeholder="e.g. my-cli {flags}"
                value={newInitialCommand}
                onChange={(e) => {
                  setNewInitialCommand(e.target.value)
                  if (testResults['__new__'])
                    setTestResults((prev) => {
                      const n = { ...prev }
                      delete n['__new__']
                      return n
                    })
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                disabled={testingId === '__new__'}
                onClick={() => handleTest('__new__', newInitialCommand.split(/\s+/)[0] || '')}
              >
                {testingId === '__new__' ? (
                  <RefreshCw className="size-3.5 mr-1.5 animate-spin" />
                ) : testResults['__new__']?.ok ? (
                  <CheckCircle2 className="size-3.5 mr-1.5 text-green-500" />
                ) : testResults['__new__']?.error ? (
                  <AlertCircle className="size-3.5 mr-1.5 text-destructive" />
                ) : (
                  <RefreshCw className="size-3.5 mr-1.5" />
                )}
                Test
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Use <code className="px-1 bg-muted rounded">{'{flags}'}</code> for task flags and{' '}
              <code className="px-1 bg-muted rounded">{'{id}'}</code> for session ID.
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase text-muted-foreground">Resume Command</Label>
            <Input
              className="font-mono text-xs"
              placeholder="e.g. my-cli {flags} --resume {id}"
              value={newResumeCommand}
              onChange={(e) => setNewResumeCommand(e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">
              Optional. Template for resuming sessions. Same variables as above.
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase text-muted-foreground">Default Flags</Label>
            <Input
              className="font-mono text-xs"
              placeholder="--json --verbose"
              value={newDefaultFlags}
              onChange={(e) => setNewDefaultFlags(e.target.value)}
            />
            <p className="text-[10px] text-muted-foreground">
              Default value for <code className="px-1 bg-muted rounded">{'{flags}'}</code>.
              Editable per task.
            </p>
          </div>

          <div className="pt-2 border-t border-dashed border-border dark:border-border space-y-3">
            <h5 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Status Detection
            </h5>
            <div className="space-y-2">
              <Label className="text-[10px] uppercase text-muted-foreground">
                Detection Engine
              </Label>
              <Select value={newDetectionEngine} onValueChange={setNewDetectionEngine}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DETECTION_ENGINES.map((e) => (
                    <SelectItem key={e.type} value={e.type}>
                      {e.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {newDetectionEngine === 'terminal' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase text-muted-foreground">Working</Label>
                  <Input
                    className="h-8 text-xs font-mono"
                    placeholder="e.g. \.\.\."
                    value={newPatternWorking}
                    onChange={(e) => setNewPatternWorking(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase text-muted-foreground">Error</Label>
                  <Input
                    className="h-8 text-xs font-mono"
                    placeholder="e.g. fail"
                    value={newPatternError}
                    onChange={(e) => setNewPatternError(e.target.value)}
                  />
                </div>
              </div>
            )}
          </div>

          <Button
            size="sm"
            className="w-full"
            disabled={!newModeLabel || !newInitialCommand}
            onClick={submitNewMode}
          >
            <Plus className="size-3.5 mr-1" />
            Add Provider
          </Button>
        </div>
      )}
    </div>
  )
}
