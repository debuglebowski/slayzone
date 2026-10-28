// The `app.usage` router: provider usage limits. The provider rows are terminal modes
// (this domain's table) read from ctx.db; only the HTTP call needs the Electron host,
// through the seam in `./usage-router-deps`. `@slayzone/api` mounts it at `app.usage`.
import { z } from 'zod'
import { router, publicProcedure } from '@slayzone/trpc-server'
import { getUsageHost } from './usage-router-deps'

const anyInput = z.unknown()

// Usage
export const appUsageRouter = router({
  fetch: publicProcedure
    .input(z.object({ force: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      // The rows live here; only the HTTP call needs Electron.
      const customRows = (await ctx.db.all(
        'SELECT id, label, usage_config FROM terminal_modes WHERE usage_config IS NOT NULL AND enabled = 1'
      )) as { id: string; label: string; usage_config: string }[]
      const builtinRows = (await ctx.db.all(
        "SELECT id, enabled FROM terminal_modes WHERE id IN ('claude-code', 'codex')"
      )) as { id: string; enabled: number }[]
      const builtinEnabled = Object.fromEntries(builtinRows.map((r) => [r.id, r.enabled === 1]))
      return getUsageHost().usageFetch({ customRows, builtinEnabled }, input?.force)
    }),
  test: publicProcedure
    .input(anyInput)
    .mutation(({ input }) => getUsageHost().usageTest(input as never))
})

export type AppUsageRouter = typeof appUsageRouter
/** Where `@slayzone/api` mounts it: `app.usage`. */
export type AppUsageMounts = { app: { usage: AppUsageRouter } }
