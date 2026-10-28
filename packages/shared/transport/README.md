# @slayzone/transport

The tRPC client: links, the boot singleton, multi-hub federation (`FederationProvider`,
`HubScope`), connect pacing/deadline, and the typed views domain code calls through.

## Typed views

There is ONE client runtime (`src/client/runtime.ts`): one `createTRPCContext`, one boot
singleton, one WebSocket + one QueryClient per hub. It is router-agnostic: typed against
`AnyTRPCRouter`, it never names a router.

Code reaches it through a **view** (`src/client/view.ts`), the runtime's own functions
re-typed for a router. A view creates nothing, so every view shares the same context,
socket and cache:

```ts
// a domain: packages/domains/<x>/src/client/trpc.ts
import { typedTrpc } from '@slayzone/transport/client'
import type { XMounts } from '../server/router' // type-only, erased from the bundle
export const { useTRPC, useTRPCClient, getTrpcClient } = typedTrpc<XMounts>()

// a domain that also calls a domain it depends on (downward only)
export const { useTRPC } = typedTrpc<XMounts & YMounts>()

// a domain that calls `app.*` routers: nested mounts name just those
// (`AppMetaMounts = { app: { meta: AppMetaRouter } }`, @slayzone/host-capabilities)
export const { useTRPC } = typedTrpc<XMounts & AppMetaMounts & AppShellMounts>()

// an app (depends on @slayzone/api): the whole router
export const { useTRPC } = trpcFor<AppRouter>()
```

A view carries `useTRPC`, `useTRPCClient`, `getTrpcClient`, `getHubClient`,
`listHubClients`, `getClientForHub/Project/Task`, `useClientForProject/Task`. Everything
router-independent (`TrpcProvider`, `FederationProvider`, `HubScope`, `useHubId`,
`useSubscription`, `useQuery`, …) is still imported from `@slayzone/transport/client`.

**Why it is sound.** tRPC clients and option proxies are path-based: a call is
`path + input` on the wire, the router type exists only at compile time. A view typed
with a slice of the app router is correct exactly when the slice is mounted at the same
keys. `XMounts` is `{ <mount key>: XRouter }`, `typedTrpc` types the runtime as
`MountedRouter<XMounts>` (what `router(XMounts)` would build, `@slayzone/trpc-server`),
and `@slayzone/api`'s `router.ts` asserts, per migrated domain, that this equals the
`AppRouter` slice at those keys. A wrong key or a drifted type fails `pnpm typecheck`.

A mount may be nested and partial: `app` holds routers of many owners (meta, shell,
browser, …), each in its owning package (`app.ts` in api composes them at the same keys,
so wire paths never change), and `{ app: { meta: AppMetaRouter } }` is just `app.meta`.
`IsMountedSlice` (`@slayzone/trpc-server`) checks every router it names is the whole
router at that path; a plain-object level names a subset of keys. Only `app.exportImport`
stays in api (it needs api's access scope), so a domain calling it stays on the whole-app
view.

## Migrating a domain

1. **Router.** `git mv packages/apps/api/src/routers/<x>.ts packages/domains/<x>/src/server/router.ts`
   (its test too, as `router.test.ts`; repoint its `run_harness` line in
   `packages/shared/test-utils/run-all.sh`). Import builders from `@slayzone/trpc-server`
   and the domain's own server code relatively. A host dep it read from api's
   `app-deps.ts` moves with it (or onto the context via `TrpcServerDeps` augmentation;
   see the trpc-server README); api re-exports any setter the hub wires. Add
   `@slayzone/trpc-server` (and `zod` if used) to the domain's `package.json`.
2. **Mounts.** In `router.ts`: `export type XRouter = typeof xRouter` and
   `export type XMounts = { <key>: XRouter }`, the key api mounts it at. Export both
   plus the router from `src/server/index.ts`.
3. **Compose.** api `router.ts`: import the router from `@slayzone/<x>/server`, keep its
   key, and add `AssertAppSlice<IsAppSlice<XMounts>>` to `DomainRouterSlices`.
4. **Client.** Add `src/client/trpc.ts` with `typedTrpc<XMounts & …deps' mounts>()` and
   switch the domain's client imports of `useTRPC`, `useTRPCClient`, `getTrpcClient`,
   `getHubClient`, `listHubClients`, `getClientFor*`, `useClientFor*`,
   `TrpcVanillaClient`, `HubWsClient` to it (`TRPCClient<MountedRouter<XMounts>>` for
   the client type). Nothing in the domain may still import those names from
   `@slayzone/transport/client`.
5. **Verify.** `pnpm -r --no-sort typecheck`, the moved router test, the domain's
   client tests, `pnpm lint:react-compiler`.

## End state (the cycle cut)

Not-yet-migrated callers use the TEMPORARY whole-app view in `src/client/trpc.ts`,
typed via `src/client/app-router.ts` (`export type { AppRouter } from '@slayzone/api'`).
Those two files are the only reason transport depends on `@slayzone/api`
(transport → api → every domain → transport). When the last domain has migrated:

- apps (`app`, `renderer-app`, `web-shell`, `chromium-shell`) define their own
  `trpcFor<AppRouter>()` view and add `@slayzone/api` as a (type-only) dependency where
  they lack it (`renderer-app`, `web-shell` get `AppRouter` through transport today);
- transport-internal users of the whole-app types move to the runtime types:
  `FederationProvider`'s `ResolvedHub.ws` (`RuntimeHubWsClient`; its one reader,
  `tasks`' `useTasksData`, re-types it with its view), `hubCapabilities`
  (`hub.describe` through a hub view or a structural type), `testing`'s
  `createTrpcTest` (generic over the router);
- delete `src/client/trpc.ts`, `src/client/app-router.ts`, the `AppRouter` re-exports
  in `src/index.ts` / `src/client/index.ts`, and `@slayzone/api` from `package.json`;
  run `node scripts/check-workspace-cycles.mjs --update`.
