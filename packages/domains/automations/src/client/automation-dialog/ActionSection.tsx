import { useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import {
  Label,
  Button,
  Input,
  Textarea,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@slayzone/ui'
import { Trash2, Sparkles, Terminal } from 'lucide-react'
import {
  TEMPLATE_VARIABLES,
  type ActionConfig,
  type ActionType
} from '@slayzone/automations/shared'
import type { AiProviderOption } from './automation-types'
import { EMPTY_RUN_COMMAND } from './automation-constants'
import { newAiAction } from './automation-helpers'

interface ActionSectionProps {
  actions: ActionConfig[]
  setActions: Dispatch<SetStateAction<ActionConfig[]>>
  providers: AiProviderOption[]
  providersLoaded: boolean
}

export function ActionSection({
  actions,
  setActions,
  providers,
  providersLoaded
}: ActionSectionProps) {
  const [showAllVars, setShowAllVars] = useState(false)

  return (
    <div className="rounded-lg border border-border/40 bg-muted/50 p-3 space-y-4">
      <div className="flex items-center justify-between">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">Then</Label>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => setActions((prev: ActionConfig[]) => [...prev, { ...EMPTY_RUN_COMMAND }])}
          >
            <Terminal className="w-3 h-3 mr-1" /> Command
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            disabled={providers.length === 0}
            onClick={() => setActions((prev: ActionConfig[]) => [...prev, newAiAction(providers[0])])}
          >
            <Sparkles className="w-3 h-3 mr-1" /> AI
          </Button>
        </div>
      </div>

      {actions.map((action, i) => {
        const updateParam = (key: string, value: string) =>
          setActions((prev: ActionConfig[]) =>
            prev.map((a: ActionConfig, j: number) =>
              j === i ? { ...a, params: { ...a.params, [key]: value } } : a
            )
          )
        const changeType = (newType: ActionType) =>
          setActions((prev: ActionConfig[]) =>
            prev.map((a: ActionConfig, j: number) => {
              if (j !== i) return a
              if (newType === a.type) return a
              return newType === 'ai' ? newAiAction(providers[0]) : { ...EMPTY_RUN_COMMAND }
            })
          )

        const storedProviderId =
          action.type === 'ai' ? ((action.params.provider as string) ?? '') : ''
        const providerMissing =
          action.type === 'ai' &&
          providersLoaded &&
          !!storedProviderId &&
          !providers.some((p) => p.id === storedProviderId)
        const flagsHasTemplate =
          action.type === 'ai' && ((action.params.flags as string) ?? '').includes('{{')

        return (
          <div
            key={i}
            className="rounded-md border border-border/40 bg-background/40 p-2 space-y-2"
          >
            <div className="flex items-center gap-2">
              <Select value={action.type} onValueChange={(v) => changeType(v as ActionType)}>
                <SelectTrigger size="sm" className="w-32 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="run_command">Run command</SelectItem>
                  <SelectItem value="ai" disabled={providers.length === 0}>
                    Run AI
                  </SelectItem>
                </SelectContent>
              </Select>
              {action.type === 'ai' && (
                <Select value={storedProviderId} onValueChange={(v) => updateParam('provider', v)}>
                  <SelectTrigger size="sm" className="flex-1">
                    <SelectValue placeholder="Pick provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <div className="flex-1" />
              {actions.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 shrink-0"
                  onClick={() =>
                    setActions((prev: ActionConfig[]) =>
                      prev.filter((_: ActionConfig, j: number) => j !== i)
                    )
                  }
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              )}
            </div>

            {providerMissing && (
              <p className="text-[11px] text-destructive">
                Provider "{storedProviderId}" is unavailable — pick another above.
              </p>
            )}

            {action.type === 'run_command' ? (
              <Textarea
                value={(action.params.command as string) ?? ''}
                onChange={(e) => updateParam('command', e.target.value)}
                placeholder="echo {{task.name}}"
                className="font-mono text-xs w-full min-h-[60px] resize-y"
              />
            ) : (
              <>
                <Textarea
                  value={(action.params.prompt as string) ?? ''}
                  onChange={(e) => updateParam('prompt', e.target.value)}
                  placeholder="Summarize {{task.name}} and post to PR"
                  className="font-mono text-xs w-full min-h-[60px] resize-y"
                />
                <Input
                  value={(action.params.flags as string) ?? ''}
                  onChange={(e) => updateParam('flags', e.target.value)}
                  placeholder="provider flags (clear to run with no flags)"
                  className="font-mono text-[11px] h-7"
                />
                {flagsHasTemplate && (
                  <p className="text-[11px] text-destructive">
                    Template variables are not allowed in flags — put them in the prompt above.
                  </p>
                )}
              </>
            )}
          </div>
        )
      })}

      <table className="w-full text-xs mt-2 border-collapse border border-border/40 rounded">
        <thead>
          <tr className="text-muted-foreground text-left bg-muted/30">
            <th className="px-2 py-1.5 font-medium border border-border/40">Variable</th>
            <th className="px-2 py-1.5 font-medium border border-border/40">Description</th>
          </tr>
        </thead>
        <tbody className="text-muted-foreground">
          {(showAllVars ? TEMPLATE_VARIABLES : TEMPLATE_VARIABLES.slice(0, 2)).map((v) => (
            <tr key={v.name}>
              <td className="px-2 py-1 font-mono text-foreground/70 border border-border/40">{`{{${v.name}}}`}</td>
              <td className="px-2 py-1 border border-border/40">{v.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        onClick={() => setShowAllVars((v) => !v)}
        className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
      >
        {showAllVars ? 'Show less' : `Show all (${TEMPLATE_VARIABLES.length} variables)`}
      </button>
    </div>
  )
}
