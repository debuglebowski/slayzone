import { useState } from 'react'
import { ChevronRight, Plus, RefreshCw, Trash2, CheckCircle2, AlertCircle } from 'lucide-react'
import { Button, IconButton, Input, Label, Switch, toast } from '@slayzone/ui'
import { groupTerminalModes } from '@slayzone/terminal'
import type { TerminalModeInfo, CreateTerminalModeInput, UpdateTerminalModeInput } from '@slayzone/terminal/shared'
import { SettingsTabIntro } from './SettingsTabIntro'
import { PanelBreadcrumb } from './PanelBreadcrumb'

interface AiProvidersSettingsTabProps {
  activeTab: string
  navigateTo: (tab: string) => void
  modes: TerminalModeInfo[]
  createMode: (input: CreateTerminalModeInput) => Promise<TerminalModeInfo>
  updateMode: (id: string, updates: UpdateTerminalModeInput) => Promise<TerminalModeInfo | null>
  deleteMode: (id: string) => Promise<boolean>
  testMode: (command: string) => Promise<{ ok: boolean; error?: string; detail?: string }>
  restoreDefaults: () => Promise<void>
  resetToDefaultState: () => Promise<void>
}

export function AiProvidersSettingsTab(props: AiProvidersSettingsTabProps) {
  const {
    activeTab, navigateTo, modes, createMode, updateMode, deleteMode, testMode, restoreDefaults, resetToDefaultState,
  } = props

  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; error?: string; detail?: string }>>({})
  const [testingId, setTestingId] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)

  // New mode state encapsulated inside the tab
  const [newModeLabel, setNewModeLabel] = useState('')
  const [newModeCommand, setNewModeCommand] = useState('')
  const [newModeArgs, setNewModeArgs] = useState('')
  const [newPatternAttention, setNewPatternAttention] = useState('')
  const [newPatternWorking, setNewPatternWorking] = useState('')
  const [newPatternError, setNewPatternError] = useState('')

  const slugify = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

  const isValidRegex = (pattern: string) => {
    try {
      new RegExp(pattern)
      return true
    } catch {
      return false
    }
  }

  const handleTest = async (id: string, command: string) => {
    if (!command) {
      toast.error('Enter a command to test')
      return
    }
    setTestingId(id)
    try {
      const res = await testMode(command)
      setTestResults(prev => ({ ...prev, [id]: res }))
      if (res.ok) {
        toast.success(`Command "${command}" is valid`)
      } else {
        toast.error(`Command "${command}" failed: ${res.error}`)
      }
    } finally {
      setTestingId(null)
    }
  }

  return (
    <>
      <SettingsTabIntro
        title="AI Providers"
        description="Configure AI coding assistants and custom terminal modes. Each provider can have its own root command and default flags."
      />

      {activeTab === 'ai-providers' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <Label className="text-base font-semibold">Providers</Label>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={restoreDefaults}>
                Restore defaults
              </Button>
              <Button variant="outline" size="sm" onClick={resetToDefaultState} className="text-destructive hover:text-destructive">
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
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Built-in</h4>
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
                            <span className="text-xs text-muted-foreground truncate max-w-[200px]">{mode.command}</span>
                            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                              <Label htmlFor={`list-enable-${mode.id}`} className="text-[10px] uppercase text-muted-foreground font-semibold cursor-pointer">Enabled</Label>
                              <Switch
                                id={`list-enable-${mode.id}`}
                                checked={mode.enabled}
                                onCheckedChange={(checked) => updateMode(mode.id, { enabled: checked })}
                              />
                            </div>
                            <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {custom.length > 0 && (
                    <div className="space-y-3 pt-4 border-t border-neutral-200 dark:border-neutral-800">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Custom</h4>
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
                            <span className="text-xs text-muted-foreground truncate max-w-[200px]">{mode.command}</span>
                            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                              <Label htmlFor={`list-enable-${mode.id}`} className="text-[10px] uppercase text-muted-foreground font-semibold cursor-pointer">Enabled</Label>
                              <Switch
                                id={`list-enable-${mode.id}`}
                                checked={mode.enabled}
                                onCheckedChange={(checked) => updateMode(mode.id, { enabled: checked })}
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
            <Button
              variant="outline"
              className="w-full border-dashed"
              onClick={() => setShowAddForm(true)}
            >
              <Plus className="size-3.5 mr-1.5" />
              Add Custom Provider
            </Button>
          ) : (
            <div className="p-4 rounded-lg border border-dashed space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold">Add Custom Provider</h4>
                <Button variant="ghost" size="sm" onClick={() => setShowAddForm(false)}>Cancel</Button>
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
                <Label className="text-xs uppercase text-muted-foreground">Command</Label>
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="npx my-ai-cli"
                    className="flex-1"
                    value={newModeCommand}
                    onChange={(e) => {
                      setNewModeCommand(e.target.value)
                      if (testResults['__new__']) setTestResults(prev => { const n = { ...prev }; delete n['__new__']; return n })
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9"
                    disabled={testingId === '__new__'}
                    onClick={() => handleTest('__new__', newModeCommand)}
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
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase text-muted-foreground">Default Flags</Label>
                <Input
                  placeholder="--json"
                  value={newModeArgs}
                  onChange={(e) => setNewModeArgs(e.target.value)}
                />
              </div>

              <div className="pt-2 border-t border-dashed border-neutral-200 dark:border-neutral-800 space-y-3">
                <h5 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Recognition Patterns (Optional)</h5>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase text-muted-foreground">Attention</Label>
                    <Input
                      className="h-8 text-xs font-mono"
                      placeholder="e.g. \? $"
                      value={newPatternAttention}
                      onChange={(e) => setNewPatternAttention(e.target.value)}
                    />
                  </div>
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
              </div>

              <Button
                size="sm"
                className="w-full"
                disabled={!newModeLabel || !newModeCommand}
                onClick={() => {
                  const generatedId = `${slugify(newModeLabel)}-${Math.random().toString(36).substring(2, 7)}`
                  createMode({
                    id: generatedId,
                    label: newModeLabel,
                    type: 'terminal',
                    command: newModeCommand,
                    args: newModeArgs,
                    enabled: true,
                    patternAttention: newPatternAttention || null,
                    patternWorking: newPatternWorking || null,
                    patternError: newPatternError || null
                  }).then(() => {
                    setNewModeLabel('')
                    setNewModeCommand('')
                    setNewModeArgs('')
                    setNewPatternAttention('')
                    setNewPatternWorking('')
                    setNewPatternError('')
                    setShowAddForm(false)
                    toast.success(`Provider "${newModeLabel}" added`)
                  }).catch(err => {
                    toast.error(err.message)
                  })
                }}
              >
                <Plus className="size-3.5 mr-1" />
                Add Provider
              </Button>
            </div>
          )}
        </div>
      )}

      {activeTab.startsWith('ai-providers/') && (() => {
        const modeId = activeTab.split('/')[1]
        const mode = modes.find(m => m.id === modeId)
        if (!mode) return null
        return (
          <div className="space-y-6">
            <PanelBreadcrumb label={mode.label} onBack={() => navigateTo('ai-providers')} parentLabel="AI Providers" />
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
                    <Label htmlFor={`enable-${mode.id}`} className="text-xs font-medium cursor-pointer">Enabled</Label>
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
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <Label className={`text-sm ${mode.isBuiltin ? 'text-muted-foreground' : ''}`}>Label</Label>
                  <Input
                    value={mode.label}
                    readOnly={mode.isBuiltin}
                    disabled={mode.isBuiltin}
                    onChange={(e) => updateMode(mode.id, { label: e.target.value })}
                    className={mode.isBuiltin ? 'bg-muted/50 cursor-not-allowed opacity-70' : ''}
                  />
                </div>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <Label className={`text-sm ${mode.isBuiltin ? 'text-muted-foreground' : ''}`}>Command</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      className={`font-mono flex-1 ${mode.isBuiltin ? 'bg-muted/50 cursor-not-allowed opacity-70' : ''}`}
                      value={mode.command ?? ''}
                      readOnly={mode.isBuiltin}
                      disabled={mode.isBuiltin}
                      onChange={(e) => {
                        updateMode(mode.id, { command: e.target.value })
                        if (testResults[mode.id]) setTestResults(prev => { const n = { ...prev }; delete n[mode.id]; return n })
                      }}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9"
                      aria-label="Test command"
                      disabled={testingId === mode.id || !mode.command}
                      onClick={() => handleTest(mode.id, mode.command!)}
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
                </div>
                <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                  <Label className="text-sm">Default Flags</Label>
                  <Input
                    className="font-mono"
                    value={mode.args ?? ''}
                    onChange={(e) => updateMode(mode.id, { args: e.target.value })}
                  />
                </div>

                <div className="pt-4 border-t border-neutral-200 dark:border-neutral-800">
                  <div className="rounded-xl border bg-neutral-50/50 dark:bg-neutral-900/30 p-5 space-y-4">
                    <div className="space-y-1">
                      <h4 className="text-sm font-semibold">Status Recognition (Advanced)</h4>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Define regular expression patterns to automatically detect the terminal state from its output. 
                        This enables the "thinking" spinner, "needs attention" badges, and error reporting for custom tools.
                      </p>
                    </div>

                    <div className="space-y-4 pt-2">
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                        <div className="space-y-0.5">
                          <Label className="text-xs font-medium">Attention Pattern</Label>
                          <p className="text-[10px] text-muted-foreground">User input required</p>
                        </div>
                        <div className="space-y-1">
                          <Input
                            className="font-mono text-xs"
                            placeholder="e.g. (?:\?|❯)\s*$"
                            value={mode.patternAttention ?? ''}
                            readOnly={mode.isBuiltin}
                            disabled={mode.isBuiltin}
                            onChange={(e) => {
                              const val = e.target.value
                              updateMode(mode.id, { patternAttention: val || null })
                            }}
                          />
                          {mode.patternAttention && !isValidRegex(mode.patternAttention) && (
                            <p className="text-[10px] text-destructive">Invalid regular expression</p>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                        <div className="space-y-0.5">
                          <Label className="text-xs font-medium">Working Pattern</Label>
                          <p className="text-[10px] text-muted-foreground">Thinking/Processing</p>
                        </div>
                        <div className="space-y-1">
                          <Input
                            className="font-mono text-xs"
                            placeholder="e.g. ⠋|⠙|⠹"
                            value={mode.patternWorking ?? ''}
                            readOnly={mode.isBuiltin}
                            disabled={mode.isBuiltin}
                            onChange={(e) => {
                              const val = e.target.value
                              updateMode(mode.id, { patternWorking: val || null })
                            }}
                          />
                          {mode.patternWorking && !isValidRegex(mode.patternWorking) && (
                            <p className="text-[10px] text-destructive">Invalid regular expression</p>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-4">
                        <div className="space-y-0.5">
                          <Label className="text-xs font-medium">Error Pattern</Label>
                          <p className="text-[10px] text-muted-foreground">Fatal/CLI errors</p>
                        </div>
                        <div className="space-y-1">
                          <Input
                            className="font-mono text-xs"
                            placeholder="e.g. ^Error:.*"
                            value={mode.patternError ?? ''}
                            readOnly={mode.isBuiltin}
                            disabled={mode.isBuiltin}
                            onChange={(e) => {
                              const val = e.target.value
                              updateMode(mode.id, { patternError: val || null })
                            }}
                          />
                          {mode.patternError && !isValidRegex(mode.patternError) && (
                            <p className="text-[10px] text-destructive">Invalid regular expression</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
    </>
  )
}
