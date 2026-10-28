/**
 * Type-level proof that `IsMountedSlice` accepts exactly the slices a path-based client
 * may be typed with. Checked by `pnpm typecheck` (nothing here runs): every
 * `@ts-expect-error` line must stay an error, so a regression that lets a wrong slice
 * through fails the build.
 */
import { publicProcedure, router } from './trpc'
import type { AssertSlice, IsMountedSlice } from './mounted-router'

const metaRouter = router({ getVersion: publicProcedure.query(() => '1.0.0') })
const shellRouter = router({
  openPath: publicProcedure.input((v) => v as { absPath: string }).mutation(() => '')
})
const tagsRouter = router({ list: publicProcedure.query(() => [] as string[]) })
/** Same procedure names as `metaRouter`, different output type. */
const driftedMetaRouter = router({ getVersion: publicProcedure.query(() => 1) })

const appRouter = router({
  app: router({ meta: metaRouter, shell: shellRouter }),
  tags: tagsRouter
})
type App = typeof appRouter

type MetaMounts = { app: { meta: typeof metaRouter } }

export type Accepted = [
  // A top-level mount (the shape every flat domain uses).
  AssertSlice<IsMountedSlice<{ tags: typeof tagsRouter }, App>>,
  // A nested, partial mount: `app.meta` without the rest of `app`.
  AssertSlice<IsMountedSlice<MetaMounts, App>>,
  // Two nested mounts under the same key, as a view intersects them.
  AssertSlice<IsMountedSlice<MetaMounts & { app: { shell: typeof shellRouter } }, App>>,
  AssertSlice<IsMountedSlice<MetaMounts & { tags: typeof tagsRouter }, App>>
]

export type Rejected = [
  // @ts-expect-error a router mounted at a key that does not exist
  AssertSlice<IsMountedSlice<{ app: { metaa: typeof metaRouter } }, App>>,
  // @ts-expect-error a router mounted at another router's key
  AssertSlice<IsMountedSlice<{ app: { shell: typeof metaRouter } }, App>>,
  // @ts-expect-error a router whose type drifted from the one mounted there
  AssertSlice<IsMountedSlice<{ app: { meta: typeof driftedMetaRouter } }, App>>,
  // @ts-expect-error a whole-router claim on a key holding more than that router
  AssertSlice<IsMountedSlice<{ app: typeof metaRouter }, App>>,
  // @ts-expect-error a nested router at the wrong depth
  AssertSlice<IsMountedSlice<{ meta: typeof metaRouter }, App>>,
  // @ts-expect-error a top-level key that does not exist
  AssertSlice<IsMountedSlice<{ tagz: typeof tagsRouter }, App>>
]
