import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { Copy, Loader2, Trash2, X } from 'lucide-react'
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Input,
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
import { SettingsTabIntro } from './SettingsTabIntro'

/**
 * Runner settings — enroll + manage the machines this hub runs work on.
 *
 * A hub ALWAYS accepts runners (the gateway + auth + listener come up at boot
 * unconditionally), so there is no mode to enable: enrollment and the runners
 * table are always live. Both talk to the `runners` tRPC router —
 * `runners.mintJoinToken` mints a one-time token embedding the hub's runner URL +
 * TLS fingerprint; `runners.list` merges live connection status. To actually run
 * a task's work on a runner, bind the project/task to it (task metadata) — until
 * then everything executes in-process.
 */

function formatLastSeen(row: { connected: boolean; lastSeenAt: number | null }): string {
  if (row.connected) return 'Connected'
  if (row.lastSeenAt == null) return 'Never'
  return new Date(row.lastSeenAt).toLocaleString()
}

export function RunnersSettingsTab() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const [label, setLabel] = useState('')
  const [minting, setMinting] = useState(false)
  const [mintedToken, setMintedToken] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null)

  // A hub always accepts runners, so the list + enrollment are always available
  // (no mode to enable). `list` merges live connection status when a runner is
  // connected; it's a plain DB read otherwise.
  const runnersQuery = useQuery(trpc.runners.list.queryOptions())
  const runners = runnersQuery.data ?? []

  const mintMutation = useMutation(trpc.runners.mintJoinToken.mutationOptions())
  const revokeMutation = useMutation(trpc.runners.revokeRunner.mutationOptions())

  const reloadRunners = useCallback(() => {
    void queryClient.invalidateQueries(trpc.runners.list.queryFilter())
  }, [queryClient, trpc])

  const addRunner = async (): Promise<void> => {
    setMinting(true)
    setMintedToken(null)
    try {
      const res = await mintMutation.mutateAsync({ label: label.trim() || 'runner' })
      setMintedToken(res.token)
      setLabel('')
      toast.success('Enrollment token created')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Could not create token: ${msg}`)
    } finally {
      setMinting(false)
    }
  }

  const revoke = async (): Promise<void> => {
    if (!revokeTarget) return
    try {
      await revokeMutation.mutateAsync({ runnerId: revokeTarget.id })
      toast.success(`Revoked ${revokeTarget.name}`)
      reloadRunners()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Revoke failed: ${msg}`)
    }
    setRevokeTarget(null)
  }

  const copyToken = async (token: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(token)
      toast.success('Token copied')
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }

  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Runners"
        description="Run terminals and agents on other machines. This app is a hub that runners dial into over an authenticated connection; enroll a runner below, then bind a project or task to it to execute its work there instead of locally."
      />

      <Card>
        <CardHeader>
          <CardTitle>Add a runner</CardTitle>
          <CardDescription>
            Mint a one-time enrollment token and paste it into the runner machine&apos;s config. The
            token embeds this hub&apos;s address and TLS fingerprint, and expires after 15 minutes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Runner label (e.g. office-mac)"
              disabled={minting}
              className="max-w-xs"
              data-testid="runner-enroll-label"
            />
            <Button
              variant="outline"
              disabled={minting}
              onClick={() => {
                void addRunner()
              }}
              data-testid="runner-add"
            >
              {minting ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Add a runner
            </Button>
          </div>
          {mintedToken && (
            <div
              className="border-border space-y-2 rounded-md border p-3"
              data-testid="runner-minted-token"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">Enrollment token</span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void copyToken(mintedToken)
                    }}
                  >
                    <Copy className="mr-1 size-3.5" />
                    Copy
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setMintedToken(null)}
                    data-testid="runner-token-dismiss"
                  >
                    <X className="mr-1 size-3.5" />
                    Done
                  </Button>
                </div>
              </div>
              <code className="text-muted-foreground block max-w-full overflow-x-auto font-mono text-xs break-all">
                {mintedToken}
              </code>
              <p className="text-muted-foreground text-xs">
                Shown once. Paste it into the runner&apos;s config now — it can&apos;t be retrieved
                later.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Runners</CardTitle>
          <CardDescription>
            {runners.length === 0
              ? 'No runners enrolled yet.'
              : `${runners.length} runner${runners.length === 1 ? '' : 's'} enrolled`}
          </CardDescription>
        </CardHeader>
        {runners.length > 0 && (
          <CardContent>
            <table className="w-full text-sm" data-testid="runners-table">
              <thead>
                <tr className="text-muted-foreground border-border border-b text-left text-xs">
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Platform</th>
                  <th className="py-2 pr-3 font-medium">Capabilities</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pr-3 font-medium">Last seen</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {runners.map((runner) => (
                  <tr
                    key={runner.id}
                    className="border-border/60 border-b last:border-0"
                    data-testid="runner-row"
                  >
                    <td className="py-2 pr-3 font-medium">{runner.name}</td>
                    <td className="text-muted-foreground py-2 pr-3 font-mono text-xs">
                      {runner.platform}
                    </td>
                    <td className="text-muted-foreground py-2 pr-3 text-xs">
                      {runner.capabilities.length > 0 ? runner.capabilities.join(', ') : '—'}
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className={
                          runner.connected
                            ? 'text-green-500 text-xs font-medium'
                            : 'text-muted-foreground text-xs'
                        }
                      >
                        {runner.connected ? '● Connected' : 'Disconnected'}
                      </span>
                    </td>
                    <td className="text-muted-foreground py-2 pr-3 text-xs">
                      {formatLastSeen(runner)}
                    </td>
                    <td className="py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRevokeTarget({ id: runner.id, name: runner.name })}
                        data-testid="runner-revoke"
                      >
                        <Trash2 className="size-3.5 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        )}
      </Card>

      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke Runner</AlertDialogTitle>
            <AlertDialogDescription>
              Revoke <strong>{revokeTarget?.name}</strong>? It will no longer be able to connect to
              this hub, and any task pinned to it falls back to the project default. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void revoke()
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
