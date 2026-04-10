import { useState, useEffect, useRef } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  Button, Input, Label, Textarea,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@slayzone/ui'
import type { LoopConfig, CriteriaType } from './useLoopMode'

interface LoopModeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  config: LoopConfig
  onSave: (config: LoopConfig) => void
}

export function LoopModeDialog({ open, onOpenChange, config, onSave }: LoopModeDialogProps) {
  const [prompt, setPrompt] = useState(config.prompt)
  const [criteriaType, setCriteriaType] = useState<CriteriaType>(config.criteriaType)
  const [criteriaPattern, setCriteriaPattern] = useState(config.criteriaPattern)
  const [maxIterations, setMaxIterations] = useState(String(config.maxIterations))

  // Sync local state only when dialog opens (not on every config change)
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setPrompt(config.prompt)
      setCriteriaType(config.criteriaType)
      setCriteriaPattern(config.criteriaPattern)
      setMaxIterations(String(config.maxIterations))
    }
    wasOpen.current = open
  }, [open, config])

  const canSave = prompt.trim().length > 0 && criteriaPattern.trim().length > 0

  const handleSave = () => {
    onSave({
      prompt: prompt.trim(),
      criteriaType,
      criteriaPattern: criteriaPattern.trim(),
      maxIterations: Math.max(1, parseInt(maxIterations) || 50)
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Loop Command</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="loop-prompt">Prompt</Label>
            <Textarea
              id="loop-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="The prompt to send each iteration..."
              rows={4}
              className="text-sm resize-y"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Acceptance criteria</Label>
            <div className="flex items-center gap-2">
              <Select value={criteriaType} onValueChange={(v) => setCriteriaType(v as CriteriaType)}>
                <SelectTrigger className="h-8 text-sm w-36 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="contains">Contains</SelectItem>
                  <SelectItem value="not-contains">Not contains</SelectItem>
                  <SelectItem value="regex">Regex</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={criteriaPattern}
                onChange={(e) => setCriteriaPattern(e.target.value)}
                placeholder="Pattern to match..."
                className="h-8 text-sm"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="loop-max">Max iterations</Label>
            <Input
              id="loop-max"
              value={maxIterations}
              onChange={(e) => setMaxIterations(e.target.value)}
              type="number"
              min={1}
              className="h-8 text-sm w-24"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!canSave} onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
