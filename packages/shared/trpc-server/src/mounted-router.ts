import type { router } from './trpc'

/**
 * Where a domain's routers sit in the composed app router: mount key → router, e.g.
 * `{ tags: typeof tagsRouter }`. Exactly the record `@slayzone/api` passes to `router()`
 * for those keys.
 */
export type RouterMounts = Parameters<typeof router>[0]

/**
 * The router `router(mounts)` would build: the composed app router narrowed to these
 * mount keys. Type-only, nothing is built. A domain's client is typed against
 * `MountedRouter<ItsMounts>` (via `typedTrpc` in `@slayzone/transport/client`)
 * instead of the whole `AppRouter`; api asserts each slice equals the matching slice
 * of `AppRouter` (`router.ts`), so a wrong key or a stale type fails the build.
 */
export type MountedRouter<TMounts extends RouterMounts> = ReturnType<typeof router<TMounts>>
