// Root barrel stays client-safe: shared types only. Server code lives behind
// the `@slayzone/hub-auth/server` export; the hub sign-in client behind
// `@slayzone/hub-auth/client` (+ `/client-node` for the Node transport).
export * from './shared'
