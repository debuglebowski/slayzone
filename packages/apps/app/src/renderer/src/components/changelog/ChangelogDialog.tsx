import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as Collapsible from '@radix-ui/react-collapsible'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  cn,
} from '@slayzone/ui'
import { Sparkles, Zap, Bug, ChevronRight } from 'lucide-react'
import { track } from '@slayzone/telemetry/client'
import { CHANGELOG, type ChangelogEntry, type ChangeCategory } from './changelog-data'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  lastSeenVersion?: string | null
}

const categoryConfig: Record<ChangeCategory, { label: string; icon: typeof Sparkles; color: string }> = {
  feature: { label: 'New', icon: Sparkles, color: 'text-violet-400' },
  improvement: { label: 'Improved', icon: Zap, color: 'text-blue-400' },
  fix: { label: 'Fixed', icon: Bug, color: 'text-amber-400' },
}

export function ChangelogDialog({ open, onOpenChange, lastSeenVersion }: Props) {
  useEffect(() => { if (open) track('changelog_viewed') }, [open])
  const entries = CHANGELOG.slice(0, 6)
  const lastSeenIndex = lastSeenVersion ? entries.findIndex((e) => e.version === lastSeenVersion) : -1
  const isNew = (i: number) => lastSeenVersion ? (lastSeenIndex === -1 || i < lastSeenIndex) : i === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden" style={{ maxWidth: 800 }} showCloseButton={false}>
        <DialogDescription className="sr-only">Recent changes and updates</DialogDescription>

        <div className="px-10 pt-10 pb-4">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold tracking-tight">What's New</DialogTitle>
          </DialogHeader>
        </div>

        <AnimatePresence>
          {open && (
            <motion.div
              className="overflow-y-auto scrollbar-thin flex-1 px-10 pb-10"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
            >
              {entries.map((entry, i) => (
                <motion.div
                  key={entry.version}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.05 + i * 0.05, duration: 0.3 }}
                >
                  <VersionAccordion entry={entry} isLatest={i === 0} defaultOpen={isNew(i)} />
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  )
}

function ItemList({ items }: { items: ChangelogEntry['items'] }) {
  return (
    <div className="space-y-4">
      {items.map((item, i) => {
        const config = categoryConfig[item.category]
        const Icon = config.icon
        return (
          <div key={i} className="flex gap-3">
            <Icon className={cn('shrink-0 mt-0.5 size-4', config.color)} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{item.title}</span>
                <span className={cn('text-[10px] uppercase tracking-wider font-semibold', config.color)}>
                  {config.label}
                </span>
              </div>
              {item.description && (
                <p className="text-[13px] text-muted-foreground mt-0.5 leading-relaxed">{item.description}</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function VersionAccordion({ entry, isLatest, defaultOpen }: { entry: ChangelogEntry; isLatest: boolean; defaultOpen: boolean }) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen}>
      <div className="pt-4">
        <Collapsible.Trigger className="flex w-full items-center gap-3 group/version cursor-pointer rounded-lg -mx-2 px-2 py-2 hover:bg-muted/50 transition-colors">
          <ChevronRight className="size-4 text-muted-foreground shrink-0 transition-transform duration-200 group-data-[state=open]/version:rotate-90" />
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <span className="text-xs font-medium text-muted-foreground">v{entry.version}</span>
            {isLatest && (
              <span className="text-[10px] uppercase tracking-widest font-bold bg-gradient-to-r from-violet-500 to-blue-500 bg-clip-text text-transparent">
                Latest
              </span>
            )}
            <span className="text-sm font-semibold tracking-tight">{entry.tagline}</span>
            <span className="text-[11px] text-muted-foreground/50 tabular-nums ml-auto shrink-0">{entry.date}</span>
          </div>
        </Collapsible.Trigger>

        <Collapsible.Content className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
          <div className="pt-4 pb-2 pl-9">
            <ItemList items={entry.items} />
          </div>
        </Collapsible.Content>

        <div className="mt-4 h-px bg-border" />
      </div>
    </Collapsible.Root>
  )
}
