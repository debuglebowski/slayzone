import {
  CircleDashed,
  Clock,
  Layers,
  ListTree,
  Rows3,
  Sparkles,
  type LucideIcon
} from 'lucide-react'
import type { LensIcon } from '@slayzone/tabs-state'
import { useShortcutDisplay } from '@slayzone/ui'

export const LENS_ICONS: Record<LensIcon, LucideIcon> = {
  today: ListTree,
  agent: Sparkles,
  status: CircleDashed,
  recent: Clock,
  accordion: Rows3,
  lens: Layers
}

export function LensIconView({
  icon,
  className
}: {
  icon: LensIcon
  className?: string
}): React.JSX.Element {
  const Icon = LENS_ICONS[icon] ?? Layers
  return <Icon className={className} />
}

/**
 * The shortcut label of the `index`-th visible lens ("⌃3"), or null past the ninth or
 * when unbound. One hook call per list: returns a formatter.
 */
export function useLensShortcutLabel(): (index: number) => string | null {
  const range = useShortcutDisplay('switch-lens-1-9')
  return (index) => (range && index < 9 ? range.replace(/1-9$/, String(index + 1)) : null)
}
