import { RefreshCw, Trash2, CheckCircle2, AlertCircle } from 'lucide-react'
import {
  Button,
  IconButton,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch
} from '@slayzone/ui'
import type { TerminalModeInfo, UpdateTerminalModeInput } from '@slayzone/terminal/shared'
import { DETECTION_ENGINES, isChatSupported } from '@slayzone/terminal/shared'
import { PanelBreadcrumb } from '../PanelBreadcrumb'
import { DebouncedInput } from './DebouncedInput'
import { UsageConfigSection } from './UsageConfigSection'
import { isValidRegex } from './utils'
import type { AiProviderForm } from './useAiProviderForm'

interface ProviderDetailViewProps {
  activeTab: string
  modes: TerminalModeInfo[]
  navigateTo: (tab: string) => void
  updateMode: (id: string, updates: UpdateTerminalModeInput) => Promise<TerminalModeInfo | null>
  deleteMode: (id: string) => Promise<boolean>
  testResults: AiProviderForm['testResults']
  setTestResults: AiProviderForm['setTestResults']
  testingId: AiProviderForm['testingId']
  handleTest: AiProviderForm['handleTest']
}

export function ProviderDetailView({
  activeTab,
  modes,
  navigateTo,
  updateMode,
  deleteMode,
  testResults,
  setTestResults,
  testingId,
  handleTest
}: ProviderDetailViewProps) {
  const modeId = activeTab.split('/')[1]
  const mode = modes.find((m) => m.id === modeId)
  if (!mode) return null
  return (
    <div className="space-y-6">
      <PanelBreadcrumb
        label={mode.label}
        onBack={() => navigateTo('ai-providers')}
        parentLabel="Providers"
      />
      <div className="rounded-lg border p-5 space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">{mode.label}</h3>
            <p className="text-sm text-muted-foreground">
              {mode.isBuiltin
                ? 'This is a built-in provider. You can only customize its default flags and enabled state.'
                : 'Configure settings for this custom provider.'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Label
                htmlFor={`enable-${mode.id}`}
                className="text-xs font-medium cursor-pointer"
              >
                Enabled
              </Label>
              <Switch
                id={`enable-${mode.id}`}
                checked={mode.enabled}
                onCheckedChange={(checked) => updateMode(mode.id, { enabled: checked })}
              />
            </div>
            {!mode.isBuiltin && (
              <IconButton
                variant="ghost"
                aria-label="Delete provider"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => {
                  if (window.confirm(`Are you sure you want to remove "${mode.label}"?`)) {
                    deleteMode(mode.id).then(() => navigateTo('ai-providers'))
                  }
                }}
              >
                <Trash2 className="size-4" />
              </IconButton>
            )}
          </div>
        </div>

        <div className="space-y-4">
          {!mode.isBuiltin && (
            <>
              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                <Label className="text-sm">Label</Label>
                <DebouncedInput
                  value={mode.label}
                  onValueCommit={(v) => updateMode(mode.id, { label: v })}
                />
              </div>
              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4">
                <div className="space-y-0.5 pt-2">
                  <Label className="text-sm">Initial Command</Label>
                  <p className="text-[10px] text-muted-foreground">Run on first launch</p>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <DebouncedInput
                      className="font-mono text-xs flex-1"
                      value={mode.initialCommand ?? ''}
                      onValueCommit={(v) => {
                        updateMode(mode.id, { initialCommand: v })
                        if (testResults[mode.id])
                          setTestResults((prev) => {
                            const n = { ...prev }
                            delete n[mode.id]
                            return n
                          })
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9"
                      aria-label="Test command"
                      disabled={testingId === mode.id || !mode.initialCommand}
                      onClick={() =>
                        handleTest(mode.id, (mode.initialCommand ?? '').split(/\s+/)[0] || '')
                      }
                    >
                      {testingId === mode.id ? (
                        <RefreshCw className="size-3.5 mr-1.5 animate-spin" />
                      ) : testResults[mode.id]?.ok ? (
                        <CheckCircle2 className="size-3.5 mr-1.5 text-green-500" />
                      ) : testResults[mode.id]?.error ? (
                        <AlertCircle className="size-3.5 mr-1.5 text-destructive" />
                      ) : (
                        <RefreshCw className="size-3.5 mr-1.5" />
                      )}
                      Test
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Use <code className="px-1 bg-muted rounded">{'{flags}'}</code> for task flags
                    and <code className="px-1 bg-muted rounded">{'{id}'}</code> for session ID.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4">
                <div className="space-y-0.5 pt-2">
                  <Label className="text-sm">Resume Command</Label>
                  <p className="text-[10px] text-muted-foreground">Run when session exists</p>
                </div>
                <div className="space-y-1">
                  <DebouncedInput
                    className="font-mono text-xs"
                    placeholder="e.g. my-cli {flags} --resume {id}"
                    value={mode.resumeCommand ?? ''}
                    onValueCommit={(v) => updateMode(mode.id, { resumeCommand: v || null })}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Optional. Same variables as initial command.
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-[140px_minmax(0,1fr)] items-start gap-4">
                <div className="space-y-0.5 pt-2">
                  <Label className="text-sm">Headless Command</Label>
                  <p className="text-[10px] text-muted-foreground">Run for one-shot AI actions</p>
                </div>
                <div className="space-y-1">
                  <DebouncedInput
                    className="font-mono text-xs"
                    placeholder="e.g. my-cli -p {prompt} {flags}"
                    value={mode.headlessCommand ?? ''}
                    onValueCommit={(v) => updateMode(mode.id, { headlessCommand: v || null })}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Optional. Use <code className="px-1 bg-muted rounded">{'{prompt}'}</code>{' '}
                    (auto-quoted) and <code className="px-1 bg-muted rounded">{'{flags}'}</code>.
                    Required to use this provider in automation AI actions.
                  </p>
                </div>
              </div>
            </>
          )}
          <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
            <Label className="text-sm">Default Flags</Label>
            <div className="space-y-1">
              <DebouncedInput
                className="font-mono text-xs"
                value={mode.defaultFlags ?? ''}
                onValueCommit={(v) => updateMode(mode.id, { defaultFlags: v })}
              />
              <p className="text-[10px] text-muted-foreground">
                Default value for <code className="px-1 bg-muted rounded">{'{flags}'}</code>.
                Editable per task.
              </p>
              {isChatSupported(mode.id) && (
                <p className="text-[10px] text-muted-foreground">
                  Note: chat sessions ignore this — applies only to automation runs (headless
                  command). Chat permissions are controlled via the per-session permission mode.
                </p>
              )}
            </div>
          </div>

          {!mode.isBuiltin && (
            <div className="pt-4 border-t border-border dark:border-border">
              <div className="rounded-xl border bg-surface-2/50 dark:bg-surface-0/30 p-5 space-y-4">
                <div className="space-y-1">
                  <h4 className="text-sm font-semibold">Status Detection</h4>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Controls how the terminal state (working, error) is detected from output.
                  </p>
                </div>

                <div className="space-y-4 pt-2">
                  <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                    <Label className="text-xs font-medium">Detection Engine</Label>
                    <Select
                      value={mode.type}
                      onValueChange={(v) => updateMode(mode.id, { type: v })}
                    >
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

                  {mode.type === 'terminal' && (
                    <>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                        <div className="space-y-0.5">
                          <Label className="text-xs font-medium">Working Pattern</Label>
                          <p className="text-[10px] text-muted-foreground">Thinking/Processing</p>
                        </div>
                        <div className="space-y-1">
                          <DebouncedInput
                            className="font-mono text-xs"
                            placeholder="e.g. ⠋|⠙|⠹"
                            value={mode.patternWorking ?? ''}
                            onValueCommit={(v) =>
                              updateMode(mode.id, { patternWorking: v || null })
                            }
                          />
                          {mode.patternWorking && !isValidRegex(mode.patternWorking) && (
                            <p className="text-[10px] text-destructive">
                              Invalid regular expression
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                        <div className="space-y-0.5">
                          <Label className="text-xs font-medium">Error Pattern</Label>
                          <p className="text-[10px] text-muted-foreground">Fatal/CLI errors</p>
                        </div>
                        <div className="space-y-1">
                          <DebouncedInput
                            className="font-mono text-xs"
                            placeholder="e.g. ^Error:.*"
                            value={mode.patternError ?? ''}
                            onValueCommit={(v) =>
                              updateMode(mode.id, { patternError: v || null })
                            }
                          />
                          {mode.patternError && !isValidRegex(mode.patternError) && (
                            <p className="text-[10px] text-destructive">
                              Invalid regular expression
                            </p>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <UsageConfigSection mode={mode} onUpdate={updateMode} />
      </div>
    </div>
  )
}
