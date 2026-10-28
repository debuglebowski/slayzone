import type { AnyTRPCProcedure, AnyTRPCRouter } from '@trpc/server'
import type { router } from './trpc'

/**
 * Where a domain's routers sit in the composed app router: mount key → router, e.g.
 * `{ tags: typeof tagsRouter }`. Exactly the record `@slayzone/api` passes to `router()`
 * for those keys.
 *
 * A mount may be NESTED to name a router mounted below a key that holds more than one
 * owner's routers: `{ app: { meta: typeof metaRouter } }` is the `meta` router at
 * `app.meta`, without the rest of `app`. A plain object level is partial (only the
 * keys it names); a router level is whole.
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

type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/** One mount value against the record entry at the same path. */
type IsSliceValue<TValue, TEntry> = TValue extends AnyTRPCRouter
  ? Exactly<TValue['_def']['record'], TEntry>
  : TValue extends AnyTRPCProcedure
    ? Exactly<TValue, TEntry>
    : IsSliceRecord<TValue, TEntry>

/** Every key of `TMounts` is in `TRecord`, and each value is that entry's slice. */
type IsSliceRecord<TMounts, TRecord> = [keyof TMounts] extends [never]
  ? false
  : {
        [K in keyof TMounts]: K extends keyof TRecord ? IsSliceValue<TMounts[K], TRecord[K]> : false
      }[keyof TMounts] extends true
    ? true
    : false

/**
 * `true` exactly when `TMounts` is a slice of `TRouter`: every key it names is mounted
 * there, every router it names is the WHOLE router at that path (its record equals
 * the record there), and a plain-object level names a subset of the keys there. tRPC
 * calls are `path + input` on the wire, so a client typed `MountedRouter<TMounts>`
 * reaches exactly what `TRouter` serves at those paths. Anything else (a wrong or
 * extra key, a router mounted elsewhere, a type that drifted) is `false`.
 */
export type IsMountedSlice<
  TMounts extends RouterMounts,
  TRouter extends AnyTRPCRouter
> = IsSliceRecord<TMounts, TRouter['_def']['record']>

/** Compile-time check: `AssertSlice<IsMountedSlice<XMounts, AppRouter>>` fails unless `true`. */
export type AssertSlice<T extends true> = T
