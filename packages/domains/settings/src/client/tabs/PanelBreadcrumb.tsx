import { ChevronLeft } from 'lucide-react'

export function PanelBreadcrumb({ label, onBack, parentLabel = 'Panels' }: { label: string; onBack: () => void; parentLabel?: string }) {
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-6"
      onClick={onBack}
    >
      <ChevronLeft className="size-3.5" />
      <span>{parentLabel}</span>
      <span className="text-muted-foreground/50">/</span>
      <span className="text-foreground font-medium">{label}</span>
    </button>
  )
}
