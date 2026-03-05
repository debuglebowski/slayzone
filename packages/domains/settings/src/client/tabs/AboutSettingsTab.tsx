import { useState, useEffect } from 'react'
import { Button, Label } from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'

export function AboutSettingsTab() {
  const [dbPath, setDbPath] = useState<string>('')
  const [cliInstalled, setCliInstalled] = useState(false)
  const [cliInstalling, setCliInstalling] = useState(false)
  const [cliMessage, setCliMessage] = useState('')

  useEffect(() => {
    window.api.settings.get('database_path').then(path => setDbPath(path ?? 'Default location (userData)'))
    window.api.app.cliStatus().then(status => setCliInstalled(status.installed))
  }, [])

  const handleInstallCli = async () => {
    setCliInstalling(true)
    setCliMessage('')
    try {
      const result = await window.api.app.installCli()
      if (result.ok) {
        setCliInstalled(true)
        setCliMessage('Installed successfully.')
      } else if (result.permissionDenied) {
        setCliMessage(`Permission denied. Run in Terminal:\n${result.error}`)
      } else {
        setCliMessage(result.error ?? 'Install failed.')
      }
    } catch (err) {
      setCliMessage(err instanceof Error ? err.message : 'Install failed.')
    } finally {
      setCliInstalling(false)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="About"
        description="View runtime and environment details for your local installation, including storage location and CLI setup."
      />
      <div className="space-y-3">
        <Label className="text-base font-semibold">Database</Label>
        <div className="text-sm text-muted-foreground">
          <p>Location: {dbPath}</p>
          <p className="text-xs mt-1">Database path can be changed via command line. Restart required.</p>
        </div>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">CLI Tool</Label>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground flex items-center gap-1.5">
            <span className={cliInstalled ? 'text-green-500' : 'text-muted-foreground'}>●</span>
            {cliInstalled ? 'Installed at /usr/local/bin/slay' : 'Not installed'}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={cliInstalling}
            onClick={handleInstallCli}
          >
            {cliInstalling ? 'Installing…' : cliInstalled ? 'Reinstall' : 'Install'}
          </Button>
        </div>
        {cliMessage && (
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap">{cliMessage}</pre>
        )}
      </div>
    </div>
  )
}
