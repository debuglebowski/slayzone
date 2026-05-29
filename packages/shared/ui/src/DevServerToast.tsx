import { useEffect, useState } from 'react'
import { Globe, X } from 'lucide-react'
import { usePresence } from './use-presence'

interface DevServerToastProps {
  url: string | null
  onOpen: () => void
  onDismiss: () => void
}

export function DevServerToast({
  url,
  onOpen,
  onDismiss
}: DevServerToastProps): React.JSX.Element | null {
  const { mounted, state } = usePresence(!!url)
  // Hold the last non-null url so text stays put during the exit animation.
  const [lastUrl, setLastUrl] = useState(url)
  useEffect(() => {
    if (url) setLastUrl(url)
  }, [url])

  if (!mounted) return null

  return (
    <div
      data-state={state}
      data-testid="dev-server-toast"
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 rounded-xl bg-surface-1 border border-border px-5 py-3.5 shadow-2xl duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-5 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-bottom-5 data-[state=closed]:zoom-out-95"
    >
      <Globe className="size-5 text-blue-500 shrink-0" />
      <span className="text-sm">
        Dev server detected at{' '}
        <code className="font-mono font-medium text-blue-400">{lastUrl}</code>
      </span>
      <button
        className="rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-3.5 py-1.5 shrink-0 transition-colors"
        onClick={onOpen}
      >
        Open preview
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
