import { Download, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from './tooltip'

interface UpdateButtonProps {
  version: string | null
  downloadPercent?: number | null
  onRestart: () => void
  size?: 'sm' | 'lg'
}

export function UpdateButton({ version, downloadPercent, onRestart, size = 'sm' }: UpdateButtonProps): React.JSX.Element | null {
  const [restarting, setRestarting] = useState(false)
  const btnSize = size === 'lg' ? 'size-10 rounded-lg' : 'h-7 w-7'
  const iconSize = size === 'lg' ? 'size-5' : 'size-4'
  const spinnerSize = size === 'lg' ? 'size-8' : 'size-6'
  const percentTextSize = size === 'lg' ? 'text-[10px]' : 'text-[8px]'

  if (!version && downloadPercent != null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            tabIndex={0}
            className={`${btnSize} relative flex items-center justify-center text-muted-foreground`}
          >
            <Loader2 className={`${spinnerSize} animate-spin opacity-50`} />
            <span className={`absolute ${percentTextSize} font-medium leading-none tabular-nums text-foreground`}>{downloadPercent}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          Downloading update — {downloadPercent}%
        </TooltipContent>
      </Tooltip>
    )
  }

  if (!version) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={() => {
            if (restarting) return
            setRestarting(true)
            onRestart()
          }}
          disabled={restarting}
          className={`${btnSize} flex items-center justify-center text-green-500 hover:text-green-400 transition-colors disabled:opacity-70 disabled:cursor-not-allowed`}
        >
          {restarting ? <Loader2 className={`${iconSize} animate-spin`} /> : <Download className={iconSize} />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {restarting ? `Restarting to install v${version}…` : `Restart to install v${version}`}
      </TooltipContent>
    </Tooltip>
  )
}
