import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { Terminal } from 'lucide-react'
import { Button, Checkbox, Dialog, DialogContent } from '@slayzone/ui'

export function CliInstallDialog() {
  const [open, setOpen] = useState(false)
  const [dontAsk, setDontAsk] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [message, setMessage] = useState('')
  const [installed, setInstalled] = useState(false)
  const checked = useRef(false)

  useEffect(() => {
    if (checked.current) return
    checked.current = true
    Promise.all([
      window.api.settings.get('onboarding_completed'),
      window.api.settings.get('cli_install_dismissed'),
      window.api.app.cliStatus()
    ]).then(([onboarded, dismissed, status]) => {
      if (onboarded === 'true' && dismissed !== 'true' && !status.installed) {
        setOpen(true)
      }
    })
  }, [])

  const handleInstall = async () => {
    setInstalling(true)
    setMessage('')
    try {
      const result = await window.api.app.installCli()
      if (result.ok) {
        setInstalled(true)
        let msg = 'Installed successfully.'
        if (result.pathNotInPATH) msg += " Note: the install directory is not in your PATH. Add it to use 'slay' from any terminal."
        setMessage(msg)
      } else if (result.permissionDenied) {
        setMessage(`Permission denied. Run in Terminal:\n${result.error}`)
      } else {
        setMessage(result.error ?? 'Install failed.')
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Install failed.')
    } finally {
      setInstalling(false)
    }
  }

  const handleClose = () => {
    if (dontAsk) window.api.settings.set('cli_install_dismissed', 'true')
    setOpen(false)
  }

  if (!open) return null

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose() }}>
      <DialogContent
        className="sm:max-w-xl p-0 overflow-hidden border-none shadow-none bg-transparent"
        showCloseButton={false}
      >
        <motion.div
          className="bg-modal rounded-lg border shadow-lg"
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        >
          <div className="px-8 py-8">
            {installed ? (
              <div className="text-center">
                <motion.div
                  className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-green-500/15"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 20, delay: 0.1 }}
                >
                  <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none">
                    <motion.path
                      d="M5 13l4 4L19 7"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-green-500"
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ duration: 0.4, delay: 0.3, ease: 'easeOut' }}
                    />
                  </svg>
                </motion.div>
                <motion.p
                  className="text-sm text-muted-foreground mb-6"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.5 }}
                >
                  CLI installed.
                </motion.p>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.6 }}
                >
                  <Button onClick={handleClose} className="w-full">Done</Button>
                </motion.div>
              </div>
            ) : (
              <>
                <div className="text-center mb-6">
                  <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
                    <Terminal className="h-7 w-7 text-primary" />
                  </div>
                  <h2 className="text-2xl font-semibold tracking-tight mb-2">Install the slay CLI</h2>
                  <p className="text-muted-foreground text-balance">
                    Manage tasks and projects from the terminal, or let your AI agents do it.
                  </p>
                </div>

                <div className="rounded-xl border overflow-hidden mb-6">
                  <table className="w-full text-sm">
                    <tbody>
                      {[
                        { cmd: 'slay tasks', desc: 'List and filter tasks' },
                        { cmd: 'slay tasks add', desc: 'Create tasks from the command line' },
                        { cmd: 'slay projects', desc: 'Switch between projects' },
                        { cmd: 'slay init', desc: 'Set up AI config for a project' },
                      ].map(({ cmd, desc }, i) => (
                        <tr key={cmd} className={i > 0 ? 'border-t' : ''}>
                          <td className="px-4 py-2.5">
                            <code className="text-xs font-medium">{cmd}</code>
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">{desc}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {message && (
                  <pre className="text-xs text-muted-foreground whitespace-pre-wrap mb-4">{message}</pre>
                )}

                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                    <Checkbox checked={dontAsk} onCheckedChange={(v) => setDontAsk(v === true)} />
                    Don't ask again
                  </label>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={handleClose} disabled={installing}>
                      Not now
                    </Button>
                    <Button onClick={handleInstall} disabled={installing}>
                      {installing ? 'Installing…' : 'Install'}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </motion.div>
      </DialogContent>
    </Dialog>
  )
}
