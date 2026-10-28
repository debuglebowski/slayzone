# @slayzone/trpc-server

The tRPC server runtime: the one `initTRPC` instance (superjson transformer, error
formatter), the procedure builders and the gate chain every procedure runs through.

## The rule

- **Domains import builders from here**: `import { router, publicProcedure } from '@slayzone/trpc-server'`.
  A domain's router lives in its own `src/server/`.
- **Only `@slayzone/api` composes routers** into `AppRouter` (`router.ts`).
- **A domain's client is typed against its own mounts**, not `AppRouter`: the domain
  exports `XMounts = { <key>: XRouter }` and its client uses
  `typedTrpc<XMounts>()` (`@slayzone/transport`, README "Typed views"), which types
  the shared client as `MountedRouter<XMounts>` from here. api asserts each slice in
  `router.ts`.
- This package depends on `@slayzone/platform`, `@trpc/server` and `superjson` only:
  never on a domain, never on `api`. It must stay out of every workspace cycle
  (`node scripts/check-workspace-cycles.mjs`).

## What lives here vs. in api

| Here (mechanism) | `@slayzone/api` (composition data) |
| --- | --- |
| `router`, `middleware`, `mergeRouters`, `publicProcedure`, `hubLocalProcedure`, `openProcedure` | `appRouter` / `AppRouter` |
| gate order: security context → auth → role → scope → owner → switch refusal → unsafe-path refusal | `TRPC_ADMIN_POLICY`, `TRPC_OWNER_POLICY` (+ `owner-gate.ts`, `access.ts`) |
| `TrpcContext`, `PrincipalRole`, `Scope` | `SCOPE_POLICY` (`@slayzone/transport/scopes`) |
| auth-gate switch (`setAuthGate`/`getAuthGate`), `ADMIN_ONLY`/`roleAllows`, admin refusal helpers | `CONDITIONAL_ADMIN`, REST/MCP tables |

The per-path tables name every router's procedures, so they cannot live below the
domains. api registers them at load (`setProcedurePolicy`, from its
`procedure-policy.ts`, imported by `router.ts`). Every gate is inert without login
(`getAuthGate()` false) and never reads the policy then; with login and no policy
registered, gated calls fail closed.

## Extension points

- **Host deps on the context**: `TrpcServerDeps` is an interface. A package that owns a
  host-wired dependency adds it by augmentation
  (`declare module '@slayzone/trpc-server' { interface TrpcServerDeps { … } }`), as
  api's `automation-engine-context.ts` does.
- **Domain refusal codes**: `registerAppCode(cause => code | undefined)` from the module
  defining the error puts its code on the wire as `data.appCode` (api's
  `join-token-policy.ts`).
