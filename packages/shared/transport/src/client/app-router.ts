// TEMPORARY. The whole-app router type, for the not-yet-migrated callers of the
// whole-app view (`./trpc.ts`). Type-only: nothing from @slayzone/api reaches a
// client bundle, but it is still the package edge transport → api (and api → every
// domain → transport). Migrated domains type themselves with `typedTrpc<XMounts>()`
// instead; once the last one has, this file, `./trpc.ts` and the dependency go
// (README.md, "End state").
export type { AppRouter } from '@slayzone/api'
