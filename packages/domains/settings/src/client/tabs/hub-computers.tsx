import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { electronBootstrap, useSubscription } from '@slayzone/transport/client'
import { DEFAULT_LOCAL_COMPUTER_NAME } from '@slayzone/platform/computer-identity'
import { Button, cn, toast } from '@slayzone/ui'
import { ArrowLeftRight, FolderCog, Power, PowerOff, RotateCw, Trash2 } from 'lucide-react'
import { useTRPC, useTRPCClient } from '../trpc'
import { useComputerActions } from './ComputerActions'
import { computerLabel } from './ComputerTakeovers'

export const LOCAL_COMPUTER_STATUS_KEY = ['local-computer-status'] as const
export const LOCAL_COMPUTER_HUBS_KEY = ['local-computer-hubs'] as const

/**
 * One hub's computers and what can be done to each — shared by the Hubs page's
 * `HubCard` rows and the Settings view's computer page, so both offer the same
 * actions with the same rules. Must render inside the hub's scope (ambient tRPC) and
 * a `ComputerActionsProvider` (confirm dialogs, roots editor).
 */
export function useHubComputers({
  hubId,
  isLocalHub,
  ownComputerId: ownComputerIdProp = null
}: {
  hubId: string
  isLocalHub: boolean
  ownComputerId?: string | null
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  // The vanilla client, not the query proxy: the roots dialog lives OUTSIDE this
  // hub's scope (one instance for all hubs), so it is handed thunks bound to this
  // hub's client rather than resolving one itself. Same reason delete is a thunk.
  const trpcClient = useTRPCClient()
  const {
    requestDelete,
    requestReplace,
    requestEditRoots,
    requestRestart,
    restarting,
    computerRevision
  } = useComputerActions()

  // A hub always accepts computers, so the list is always available (no mode to
  // enable). `list` merges live connection status when a computer is connected;
  // it's a plain DB read otherwise.
  const computersQuery = useQuery({ ...trpc.computers.list.queryOptions(), refetchInterval: 5000 })

  // Connection changes push immediately; polling also refreshes independent upgrade
  // reports. The hub already knows the moment a computer connects, drops or is
  // reaped by the heartbeat watchdog. Invalidate rather than patch the cache: the
  // row also carries machine and ownership fields this event knows nothing about.
  useSubscription(
    trpc.computers.onStatusChange.subscriptionOptions(undefined, {
      onData: () => {
        void queryClient.invalidateQueries(trpc.computers.list.queryFilter())
        void queryClient.invalidateQueries({ queryKey: LOCAL_COMPUTER_STATUS_KEY })
      }
    })
  )
  const computers = computersQuery.data ?? []

  // Where THIS app's own computer stands on this (remote) hub — it joins every hub
  // the client lists. Main-process state, like the local computer's status.
  const ownHubQuery = useQuery({
    queryKey: [...LOCAL_COMPUTER_HUBS_KEY],
    queryFn: () => electronBootstrap.getLocalComputerHubs(),
    enabled: !isLocalHub,
    refetchInterval: 5000
  })
  const ownOnThisHub = isLocalHub ? null : (ownHubQuery.data?.[hubId] ?? null)
  const ownComputerId = ownComputerIdProp ?? ownOnThisHub?.computerId ?? null

  const deleteMutation = useMutation(trpc.computers.delete.mutationOptions())
  const replaceMutation = useMutation(trpc.computers.replace.mutationOptions())
  const setDisabledMutation = useMutation(trpc.computers.setDisabled.mutationOptions())

  // Refetch after the local computer is restarted/started. The computer re-dials
  // asynchronously after the spawn returns, so without this the list would sit on
  // "Disconnected".
  useEffect(() => {
    if (computerRevision === 0) return
    void queryClient.invalidateQueries(trpc.computers.list.queryFilter())
  }, [computerRevision, queryClient, trpc])

  type Row = (typeof computers)[number]

  /** This app's own computer on this hub: never deleted, and on the local hub never
   *  disabled either (nothing on this machine could run without it). */
  const isOwnComputer = (computer: { id: string; name: string }): boolean =>
    computer.id === ownComputerId || (isLocalHub && computer.name === DEFAULT_LOCAL_COMPUTER_NAME)

  /**
   * Replace `former` with a successor the user picks among this hub's other computers
   * (`preselect`: the one a takeover offer names). Hub-bound like delete.
   */
  const askReplace = (former: { id: string; name: string }, preselect?: string): void => {
    requestReplace({
      former: { id: former.id, label: computerLabel(former, computers) },
      options: computers
        .filter((c) => c.id !== former.id)
        .map((c) => ({ id: c.id, label: computerLabel(c, computers), connected: c.connected })),
      preselect,
      replace: async (successorId) => {
        await replaceMutation.mutateAsync({ computerId: former.id, successorId })
        void queryClient.invalidateQueries(trpc.computers.list.queryFilter())
        void queryClient.invalidateQueries(trpc.computers.takeovers.queryFilter())
      }
    })
  }

  const toggleDisabled = async (computer: Row): Promise<void> => {
    const disable = computer.disabledAt == null
    await setDisabledMutation.mutateAsync({ computerId: computer.id, disabled: disable }).then(
      () => toast.success(`${disable ? 'Disabled' : 'Enabled'} ${computer.name}`),
      // The hub says why — most often terminals or agents still running there.
      (err: unknown) => toast.error(err instanceof Error ? err.message : String(err))
    )
    void queryClient.invalidateQueries(trpc.computers.list.queryFilter())
  }

  const editRoots = (computer: Row): void =>
    requestEditRoots({
      id: computer.id,
      name: computer.name,
      load: () => trpcClient.workspace.listRoots.query({ computerId: computer.id }),
      save: (roots) =>
        trpcClient.workspace.setAllowedRoots.mutate({ computerId: computer.id, roots })
    })

  const remove = (computer: Row): void =>
    requestDelete({
      id: computer.id,
      name: computer.name,
      // Closed over this hub's mutation + QueryClient, so a delete cannot be routed
      // to the wrong hub.
      remove: async () => {
        await deleteMutation.mutateAsync({ computerId: computer.id })
        void queryClient.invalidateQueries(trpc.computers.list.queryFilter())
      }
    })

  return {
    computersQuery,
    computers,
    ownOnThisHub,
    ownComputerId,
    isLocalHub,
    isOwnComputer,
    askReplace,
    toggleDisabled,
    togglingDisabled: setDisabledMutation.isPending,
    editRoots,
    remove,
    requestRestart,
    restarting
  }
}

export type HubComputers = ReturnType<typeof useHubComputers>
type ComputerRow = HubComputers['computers'][number]

/**
 * A computer's actions, as icon buttons (`labels`: with words, for the computer
 * page). The rules on WHICH apply live here, once.
 */
export function ComputerActionButtons({
  computer,
  hub,
  labels = false
}: {
  computer: ComputerRow
  hub: HubComputers
  labels?: boolean
}) {
  const { isLocalHub, isOwnComputer, computers, restarting } = hub
  const size = labels ? 'sm' : 'icon-sm'
  const variant = labels ? 'outline' : 'ghost'
  return (
    <div className={cn('flex items-center', labels ? 'flex-wrap gap-2' : 'justify-end')}>
      {/* Which folders this computer may touch. Offered for EVERY computer, local
          included: filesystem work runs on the computer that owns the workspace, so
          a project outside these roots is one the UI genuinely cannot open. */}
      <Button
        variant={variant}
        size={size}
        title="Folders this computer may access"
        onClick={() => hub.editRoots(computer)}
        data-testid="computer-edit-roots"
      >
        <FolderCog className="size-3.5" />
        {labels && 'Allowed folders'}
      </Button>
      {/* The app's OWN supervised child — the one computer it can cycle as a process.
          Restarting kills every agent pty on this machine, so it is confirm-gated. */}
      {isLocalHub && computer.name === DEFAULT_LOCAL_COMPUTER_NAME && (
        <Button
          variant={variant}
          size={size}
          disabled={restarting}
          title="Restart local computer (stops running agents + terminals; reconnects automatically)"
          onClick={hub.requestRestart}
          data-testid="computer-local-restart"
        >
          <RotateCw className={cn('size-3.5', restarting && 'animate-spin')} />
          {labels && 'Restart'}
        </Button>
      )}
      {/* Disable: kept and connected, but given no new work. Every computer except the
          app's own on the local hub. The hub refuses while terminals or agents run
          there, and says so. */}
      {!(isLocalHub && isOwnComputer(computer)) && (
        <Button
          variant={variant}
          size={size}
          disabled={hub.togglingDisabled}
          title={
            computer.disabledAt != null
              ? 'Enable — let this computer take work again'
              : 'Disable — keep this computer, but send it no new work'
          }
          aria-pressed={computer.disabledAt != null}
          onClick={() => void hub.toggleDisabled(computer)}
          data-testid={computer.disabledAt != null ? 'computer-enable' : 'computer-disable'}
        >
          {computer.disabledAt != null ? (
            <Power className="size-3.5" />
          ) : (
            <PowerOff className="size-3.5" />
          )}
          {labels && (computer.disabledAt != null ? 'Enable' : 'Disable')}
        </Button>
      )}
      {/* Replace: an OFFLINE computer whose machine enrolled again under a new id —
          its work moves to the new row. Not a connected one, not the app's own. */}
      {!computer.connected &&
        !isOwnComputer(computer) &&
        computers.some((c) => c.id !== computer.id) && (
          <Button
            variant={variant}
            size={size}
            title="Replace with… — this machine was enrolled again under a new id"
            onClick={() => hub.askReplace(computer)}
            data-testid="computer-replace"
          >
            <ArrowLeftRight className="size-3.5" />
            {labels && 'Replace with…'}
          </Button>
        )}
      {/* The app's own computer is never deleted, on any hub: the app joins every hub
          it lists, so it would only enroll it again. Disable it instead. */}
      {!isOwnComputer(computer) && (
        <Button
          variant={variant}
          size={size}
          title="Delete this computer from the hub"
          onClick={() => hub.remove(computer)}
          data-testid="computer-delete"
        >
          <Trash2 className="text-destructive size-3.5" />
          {labels && 'Remove from hub'}
        </Button>
      )}
    </div>
  )
}
