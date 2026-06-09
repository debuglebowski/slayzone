import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Button } from '@slayzone/ui'
import { useTRPC } from '@slayzone/transport/client'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Terminal } from 'lucide-react'
import { CLI_FEATURES } from './onboardingConstants'

export function CliInstallStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  const trpc = useTRPC()
  const [message, setMessage] = useState('')
  const [installed, setInstalled] = useState<boolean | null>(null)

  const statusQuery = useQuery(trpc.app.meta.checkCliInstalled.queryOptions())
  const installMutation = useMutation(trpc.app.meta.installCli.mutationOptions())
  const installing = installMutation.isPending

  useEffect(() => {
    if (statusQuery.data) setInstalled(statusQuery.data.installed)
  }, [statusQuery.data])

  const handleInstall = async () => {
    setMessage('')
    try {
      const result = await installMutation.mutateAsync()
      if (result.ok) {
        setInstalled(true)
        let msg = 'Installed successfully.'
        if (result.pathNotInPATH)
          msg +=
            " Note: the install directory is not in your PATH. Add it to use 'slay' from any terminal."
        setMessage(msg)
      } else if (result.elevationCancelled) {
        setMessage('Install cancelled. You can try again later from Settings.')
      } else if (result.permissionDenied) {
        setMessage(`Permission denied. Run in Terminal:\n${result.error}`)
      } else {
        setMessage(result.error ?? 'Install failed.')
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Install failed.')
    }
  }

  // Loading state while checking
  if (installed === null) return <div />

  return (
    <motion.div
      key="cli"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      {!installed && (
        <div className="text-center mb-6">
          <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
            <Terminal className="h-7 w-7 text-primary" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight mb-2">Install the slay CLI</h2>
          <p className="text-muted-foreground text-balance">
            Manage tasks and projects from the terminal, or let your AI agents do it.
          </p>
        </div>
      )}

      {!installed && (
        <div className="rounded-xl border overflow-hidden mb-6">
          <table className="w-full text-sm">
            <tbody>
              {CLI_FEATURES.map(({ cmd, desc }, i) => (
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
      )}

      {installed ? (
        <div className="text-center">
          <motion.div
            className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-500/15"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20, delay: 0.1 }}
          >
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none">
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
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }}>
            <Button onClick={onNext} className="w-full h-11">
              Continue
            </Button>
          </motion.div>
        </div>
      ) : (
        <>
          {message && (
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap text-left mb-4">
              {message}
            </pre>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Button variant="outline" className="h-11" onClick={onNext} disabled={installing}>
              Skip
            </Button>
            <Button className="h-11" onClick={handleInstall} disabled={installing}>
              {installing ? 'Installing…' : 'Install'}
            </Button>
          </div>
        </>
      )}
    </motion.div>
  )
}
