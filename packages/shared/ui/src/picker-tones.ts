import {
  Crown,
  Feather,
  Flame,
  Leaf,
  Signal,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Sparkles,
  type LucideIcon
} from 'lucide-react'

/** A picker color: chip (selected row / pill), its hover, and text-only. */
export interface PickerTone {
  chip: string
  chipHover: string
  text: string
}

// Literal class lists (Tailwind only sees full class names in source).
export const TONES = {
  teal: {
    chip: 'bg-teal-500/15 text-teal-600 dark:text-teal-300 ring-teal-500/30',
    chipHover: 'hover:bg-teal-500/25',
    text: 'text-teal-600 dark:text-teal-300'
  },
  blue: {
    chip: 'bg-blue-500/15 text-blue-600 dark:text-blue-300 ring-blue-500/30',
    chipHover: 'hover:bg-blue-500/25',
    text: 'text-blue-600 dark:text-blue-300'
  },
  indigo: {
    chip: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 ring-indigo-500/30',
    chipHover: 'hover:bg-indigo-500/25',
    text: 'text-indigo-600 dark:text-indigo-300'
  },
  violet: {
    chip: 'bg-violet-500/15 text-violet-600 dark:text-violet-300 ring-violet-500/30',
    chipHover: 'hover:bg-violet-500/25',
    text: 'text-violet-600 dark:text-violet-300'
  },
  rose: {
    chip: 'bg-rose-500/15 text-rose-600 dark:text-rose-300 ring-rose-500/30',
    chipHover: 'hover:bg-rose-500/25',
    text: 'text-rose-600 dark:text-rose-300'
  },
  fuchsia: {
    chip: 'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-300 ring-fuchsia-500/30',
    chipHover: 'hover:bg-fuchsia-500/25',
    text: 'text-fuchsia-600 dark:text-fuchsia-300'
  },
  lime: {
    chip: 'bg-lime-500/15 text-lime-700 dark:text-lime-300 ring-lime-500/30',
    chipHover: 'hover:bg-lime-500/25',
    text: 'text-lime-700 dark:text-lime-300'
  },
  amber: {
    chip: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30',
    chipHover: 'hover:bg-amber-500/25',
    text: 'text-amber-700 dark:text-amber-300'
  }
} satisfies Record<string, PickerTone>

/** Neutral (theme tokens): an unknown/unlisted model. */
export const NEUTRAL_TONE: PickerTone = {
  chip: 'bg-muted/40 text-muted-foreground ring-border',
  chipHover: 'hover:bg-muted/60 hover:text-foreground',
  text: 'text-muted-foreground'
}

export interface PickerLook {
  icon: LucideIcon
  tone: PickerTone
}

const CLAUDE_MODEL_LOOKS: Record<string, PickerLook> = {
  opus: { icon: Crown, tone: TONES.fuchsia },
  sonnet: { icon: Feather, tone: TONES.teal },
  haiku: { icon: Leaf, tone: TONES.lime }
}

/** Other providers' models (no known identity): a color by list position. */
const MODEL_ROTATION: PickerTone[] = [
  TONES.blue,
  TONES.teal,
  TONES.fuchsia,
  TONES.lime,
  TONES.amber,
  TONES.violet
]

/** A model's icon + color: Claude's aliases fixed, others by `index` in their list (-1: neutral). */
export function modelLook(id: string, index: number): PickerLook {
  return (
    CLAUDE_MODEL_LOOKS[id] ?? {
      icon: Sparkles,
      tone: index < 0 ? NEUTRAL_TONE : MODEL_ROTATION[index % MODEL_ROTATION.length]
    }
  )
}

/** Effort ramp, least → most reasoning. */
const EFFORT_LOOKS: PickerLook[] = [
  { icon: SignalLow, tone: TONES.teal },
  { icon: SignalMedium, tone: TONES.blue },
  { icon: SignalHigh, tone: TONES.indigo },
  { icon: Signal, tone: TONES.violet },
  { icon: Flame, tone: TONES.rose }
]

/** An effort level's icon + color by its place (`index` of `count`) in the model's levels. */
export function effortLook(index: number, count: number): PickerLook {
  if (index < 0) return { icon: SignalMedium, tone: NEUTRAL_TONE }
  const k = count <= 1 ? 0 : Math.round((index / (count - 1)) * (EFFORT_LOOKS.length - 1))
  return EFFORT_LOOKS[k]
}
