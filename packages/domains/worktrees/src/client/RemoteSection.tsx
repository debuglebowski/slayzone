import { useState, useCallback } from 'react'
import { ChevronDown, Loader2, Download, Upload } from 'lucide-react'
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  toast
} from '@slayzone/ui'
import type { AheadBehind } from '../shared/types'

interface RemoteSectionProps {
  remoteUrl?: string
  upstreamAB: AheadBehind | null
  targetPath: string
  branch: string | null
  onSyncDone: () => void
}

export function RemoteSection({ upstreamAB, targetPath, branch, onSyncDone }: RemoteSectionProps) {
  const [pushing, setPushing] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [pushMenuOpen, setPushMenuOpen] = useState(false)
  const [forcePushConfirmOpen, setForcePushConfirmOpen] = useState(false)

  const handlePush = useCallback(async (force?: boolean) => {
    setPushing(true)
    setPushMenuOpen(false)
    setForcePushConfirmOpen(false)
    try {
      const result = await window.api.git.push(targetPath, branch ?? undefined, force)
      if (!result.success) {
        toast(result.error ?? 'Push failed')
      } else {
        toast(force ? 'Force pushed' : 'Pushed')
        onSyncDone()
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Push failed')
    } finally {
      setPushing(false)
    }
  }, [targetPath, branch, onSyncDone])

  const handlePull = useCallback(async () => {
    setPulling(true)
    try {
      const result = await window.api.git.pull(targetPath)
      if (!result.success) {
        toast(result.error ?? 'Pull failed')
      } else {
        toast('Pulled')
        onSyncDone()
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Pull failed')
    } finally {
      setPulling(false)
    }
  }, [targetPath, onSyncDone])

  const behind = upstreamAB?.behind ?? 0
  const ahead = upstreamAB?.ahead ?? 0

  return (
    <>
      <div className="flex items-center gap-1.5 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={handlePull}
              disabled={pulling || pushing}
              className="gap-1 h-7 px-2"
            >
              {pulling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Pull{behind > 0 && ` ↓${behind}`}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{behind > 0 ? `Pull ${behind} commit${behind !== 1 ? 's' : ''} from remote` : 'Pull from remote'}</TooltipContent>
        </Tooltip>
        <div className="flex">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePush(false)}
                disabled={pushing || pulling}
                className="gap-1 h-7 px-2 rounded-r-none border-r-0"
              >
                {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                Push{ahead > 0 && ` ↑${ahead}`}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{ahead > 0 ? `Push ${ahead} commit${ahead !== 1 ? 's' : ''} to remote` : 'Push to remote'}</TooltipContent>
          </Tooltip>
          <Popover open={pushMenuOpen} onOpenChange={setPushMenuOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={pushing || pulling}
                className="px-1 h-7 rounded-l-none"
              >
                <ChevronDown className="h-3 w-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-40 p-1">
              <button
                onClick={() => { setPushMenuOpen(false); setForcePushConfirmOpen(true) }}
                className="flex items-center gap-2 w-full px-2 py-1.5 text-xs hover:bg-muted rounded transition-colors text-left text-destructive"
              >
                Force Push
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <AlertDialog open={forcePushConfirmOpen} onOpenChange={setForcePushConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force Push</AlertDialogTitle>
            <AlertDialogDescription>
              This will overwrite the remote branch history using --force-with-lease. This can cause others to lose work if they've pushed to this branch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => handlePush(true)}>Force Push</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
