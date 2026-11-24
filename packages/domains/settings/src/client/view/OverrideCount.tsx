import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Switch, toast } from '@slayzone/ui'
import { useTRPC } from '../trpc'

/** The hub key that locks `settingKey` for projects (settings-core `POLICY_LOCK_PREFIX`). */
const lockKey = (settingKey: string) => `policy_lock:${settingKey}`

/**
 * Under a hub setting a project may override (plans/settings-by-scope.md): how many
 * of this hub's projects use their own value, and the hub admin's "Lock for projects"
 * switch (phase 6) that makes every project use the hub's value. The count is absent
 * when none do, or on a hub too old to say.
 */
export function OverrideCount({ settingKey }: { settingKey: string }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const overrides = useQuery(
    trpc.settings.overridesOfKey.queryOptions({ key: settingKey }, { retry: false })
  )
  const lock = useQuery(trpc.settings.get.queryOptions({ key: lockKey(settingKey) }))
  const setLock = useMutation(
    trpc.settings.set.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries(),
      // Hub settings are admin-only on a hub with sign-in; the hub says so.
      onError: (err) => toast.error(`Could not change the lock: ${err.message}`)
    })
  )
  const locked = lock.data === '1'
  const n = overrides.data?.length ?? 0
  return (
    <span className="flex flex-wrap items-center gap-2">
      {n > 0 && (
        <span
          className="rounded-full border px-2 text-[11px] leading-5 text-muted-foreground"
          data-testid={`override-count-${settingKey}`}
        >
          {n} project{n === 1 ? '' : 's'} use{n === 1 ? 's' : ''} its own value
        </span>
      )}
      {lock.isSuccess && (
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Switch
            checked={locked}
            disabled={setLock.isPending}
            onCheckedChange={(on) =>
              setLock.mutate({ key: lockKey(settingKey), value: on ? '1' : '0' })
            }
            data-testid={`lock-for-projects-${settingKey}`}
            aria-label="Lock for projects"
          />
          Lock for projects
        </label>
      )}
    </span>
  )
}
