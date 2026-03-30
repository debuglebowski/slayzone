import { useState } from 'react'
import { format, setHours, setMinutes, addHours, addDays, nextMonday, isAfter } from 'date-fns'
import type { LucideIcon } from 'lucide-react'
import { AlarmClock, Clock, Clock3, Sun, Moon, Calendar as CalendarIcon } from 'lucide-react'
import {
  Calendar, Button, Label,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter
} from '@slayzone/ui'

export interface SnoozePreset {
  label: string
  icon: LucideIcon
  getDate: () => Date
}

export function getSnoozePresets(): SnoozePreset[] {
  const now = new Date()
  return [
    {
      label: 'In 1 hour',
      icon: Clock,
      getDate: () => addHours(now, 1)
    },
    {
      label: 'In 3 hours',
      icon: Clock3,
      getDate: () => addHours(now, 3)
    },
    {
      label: 'Later today',
      icon: Sun,
      getDate: () => {
        const fourPm = setMinutes(setHours(now, 16), 0)
        return isAfter(fourPm, addHours(now, 1)) ? fourPm : addHours(now, 3)
      }
    },
    {
      label: 'Tomorrow',
      icon: Moon,
      getDate: () => setMinutes(setHours(addDays(now, 1), 9), 0)
    },
    {
      label: 'Next week',
      icon: CalendarIcon,
      getDate: () => setMinutes(setHours(nextMonday(now), 9), 0)
    }
  ]
}

// --- Custom snooze dialog (shared by sidebar popover + context menu) ---

interface CustomSnoozeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSnooze: (until: string) => void
}

export function CustomSnoozeDialog({ open, onOpenChange, onSnooze }: CustomSnoozeDialogProps): React.JSX.Element {
  const [date, setDate] = useState<Date | undefined>()
  const [time, setTime] = useState('09:00')

  const resolvedDate = date
    ? setMinutes(setHours(date, Number(time.split(':')[0])), Number(time.split(':')[1]))
    : null

  const handleConfirm = (): void => {
    if (!resolvedDate) return
    onSnooze(resolvedDate.toISOString())
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent style={{ maxWidth: 400 }} className="p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle>Snooze until</DialogTitle>
          <DialogDescription className="text-xs">
            Pick a date and time, or choose a preset.
          </DialogDescription>
        </DialogHeader>

        {/* Calendar + time */}
        <div className="px-5 py-4 space-y-4">
          <div className="flex justify-center">
            <Calendar
              mode="single"
              selected={date}
              onSelect={setDate}
              disabled={{ before: new Date() }}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Time
            </Label>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          {/* Preview */}
          {resolvedDate && (
            <div className="rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-center text-sm font-medium">
              {format(resolvedDate, 'EEEE, MMMM d · h:mm a')}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={handleConfirm} disabled={!date}>Snooze</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// --- Sidebar snooze picker (presets + custom button) ---

interface SnoozePickerProps {
  onSnooze: (until: string) => void
  onClose?: () => void
}

export function SnoozePicker({ onSnooze, onClose }: SnoozePickerProps): React.JSX.Element {
  const [customOpen, setCustomOpen] = useState(false)
  const presets = getSnoozePresets()

  const handlePreset = (preset: SnoozePreset): void => {
    onSnooze(preset.getDate().toISOString())
    onClose?.()
  }

  const handleCustomSnooze = (until: string): void => {
    onSnooze(until)
    onClose?.()
  }

  return (
    <>
      <div className="py-1">
        {presets.map((preset) => {
          const Icon = preset.icon
          return (
            <button
              key={preset.label}
              onClick={() => handlePreset(preset)}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <Icon className="size-3.5" />
              <span className="flex-1 text-left">{preset.label}</span>
              <span className="text-xs text-muted-foreground">{format(preset.getDate(), 'EEE, MMM d · h:mm a')}</span>
            </button>
          )
        })}
        <button
          onClick={() => setCustomOpen(true)}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
        >
          <AlarmClock className="size-3.5" />
          Custom...
        </button>
      </div>
      <CustomSnoozeDialog open={customOpen} onOpenChange={setCustomOpen} onSnooze={handleCustomSnooze} />
    </>
  )
}
