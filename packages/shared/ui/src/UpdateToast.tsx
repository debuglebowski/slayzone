import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { usePresence } from './use-presence'

interface UpdateToastProps {
  version: string | null
  onRestart: () => void
  onDismiss: () => void
}

export function UpdateToast({
  version,
  onRestart,
  onDismiss
}: UpdateToastProps): React.JSX.Element | null {
  const { mounted, state } = usePresence(!!version)
  // Hold the last non-null version so text stays put during the exit animation.
  const [lastVersion, setLastVersion] = useState(version)
  useEffect(() => {
    if (version) setLastVersion(version)
  }, [version])

  if (!mounted) return null

  return (
    <div
      data-state={state}
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 rounded-xl bg-surface-1 border border-border px-5 py-3.5 shadow-2xl duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-5 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-bottom-5 data-[state=closed]:zoom-out-95"
    >
      <Download className="size-5 text-green-500 shrink-0" />
      <span className="text-sm">
        Update <code className="font-mono font-medium text-green-400">v{lastVersion}</code> ready
      </span>
      <button
        className="rounded-md bg-green-600 hover:bg-green-500 text-white text-sm font-medium px-3.5 py-1.5 shrink-0 transition-colors"
        onClick={onRestart}
      >
        Restart
      </button>
      <button
        className="text-muted-foreground hover:text-foreground shrink-0 p-1"
        onClick={onDismiss}
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
