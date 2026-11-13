import type {
  AnyTRPCProcedure,
  inferProcedureInput,
  TRPCBuiltRouter,
  TRPCMutationProcedure,
  TRPCQueryProcedure,
  TRPCSubscriptionProcedure
} from '@trpc/server'

/** `I` with its `target` field optional (the ambient client adds it), else `I`. */
type TargetOptional<I> = I extends { target: infer T } ? Omit<I, 'target'> & { target?: T } : I

// Only procedures whose input names a `target` change; every other one (and its
// output inference) passes through untouched.
type AmbientProcedure<P> = P extends AnyTRPCProcedure
  ? inferProcedureInput<P> extends { target: unknown }
    ? Mapped<P>
    : P
  : P

type Mapped<P> =
  P extends TRPCQueryProcedure<infer D>
    ? TRPCQueryProcedure<{
        input: TargetOptional<D['input']>
        output: D['output']
        meta: D['meta']
      }>
    : P extends TRPCMutationProcedure<infer D>
      ? TRPCMutationProcedure<{
          input: TargetOptional<D['input']>
          output: D['output']
          meta: D['meta']
        }>
      : P extends TRPCSubscriptionProcedure<infer D>
        ? TRPCSubscriptionProcedure<{
            input: TargetOptional<D['input']>
            output: D['output']
            meta: D['meta']
          }>
        : P

/**
 * The CLIENT view of a router whose procedures REQUIRE a `target` (path scope,
 * §9 Phase 7b): the same router with `target` optional, for a client that adds it
 * itself from an ambient provider (the git panel's scoped proxy). Only that proxy
 * may be typed with this view; every other caller sees the router as it is, so a
 * call that names no scope fails typecheck.
 */
export type WithAmbientTarget<R> =
  R extends TRPCBuiltRouter<infer Root, infer Def>
    ? TRPCBuiltRouter<Root, { [K in keyof Def]: AmbientProcedure<Def[K]> }>
    : never
