import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'

/**
 * Read a single key/value setting. Returns the raw string the server stored,
 * or `undefined`/`null` until the read resolves. Caller decides how to coerce/default.
 */
export function useSetting(key: string): string | null | undefined {
  const trpc = useTRPC()
  const { data } = useQuery(trpc.settings.get.queryOptions({ key }))
  return data
}

/**
 * Mutation hook for `settings.set`. Optimistically writes to the cache so the
 * UI reflects the change immediately (matches the pre-migration pattern where
 * a local `useState` mirrored the value before the server confirmed). On error
 * it rolls back to the previous cached value.
 */
export function useSetSettingMutation() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return useMutation(
    trpc.settings.set.mutationOptions({
      onMutate: ({ key, value }) => {
        const queryKey = trpc.settings.get.queryKey({ key })
        queryClient.cancelQueries({ queryKey })
        const prev = queryClient.getQueryData<string | null | undefined>(queryKey)
        queryClient.setQueryData(queryKey, value)
        return { prev }
      },
      onError: (_err, { key }, ctx) => {
        if (!ctx) return
        queryClient.setQueryData(trpc.settings.get.queryKey({ key }), ctx.prev)
      },
    }),
  )
}
