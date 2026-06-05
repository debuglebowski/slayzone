import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { toast } from '@slayzone/ui'

export interface AppUpdatesApi {
  updateVersion: string | null
  updateDownloadPercent: number | null
  updateToastDismissed: boolean
  setUpdateToastDismissed: Dispatch<SetStateAction<boolean>>
}

// Auto-updater status → toast + the version/percent state the header and
// update toast read.
export function useAppUpdates(): AppUpdatesApi {
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [updateDownloadPercent, setUpdateDownloadPercent] = useState<number | null>(null)
  const [updateToastDismissed, setUpdateToastDismissed] = useState(false)

  useEffect(() => {
    return window.api.app.onUpdateStatus((status) => {
      switch (status.type) {
        case 'checking':
          toast.loading('Checking for updates...', { id: 'update-check' })
          break
        case 'downloading':
          setUpdateDownloadPercent(status.percent)
          setUpdateVersion(null)
          toast.dismiss('update-check')
          break
        case 'downloaded':
          toast.dismiss('update-check')
          setUpdateDownloadPercent(null)
          setUpdateVersion(status.version)
          setUpdateToastDismissed(false)
          break
        case 'not-available':
          setUpdateDownloadPercent(null)
          toast.success("You're on the latest version", { id: 'update-check' })
          break
        case 'error':
          setUpdateDownloadPercent(null)
          toast.dismiss('update-check')
          toast.error(`Update failed: ${status.message}`, { duration: 8000 })
          break
      }
    })
  }, [])

  return { updateVersion, updateDownloadPercent, updateToastDismissed, setUpdateToastDismissed }
}
