/**
 * The scope vocabulary. Kept deliberately tiny — a large vocabulary rots.
 *
 *   full  — everything that exists today: the desktop app, the CLI, and any
 *           session resolved via `verifySession` (a real better-auth session,
 *           reached by a bearer or the bootstrap-owner token). A `full`
 *           principal SKIPS the scope check entirely (see `trpc.ts`), so every
 *           existing client is byte-identical to before scopes existed.
 *   read  — observe-only queries and subscriptions. No mutation of any kind.
 *   tasks — task / project / tag / artifact / terminal-tab CRUD. The
 *           collaborative surface a web user actually edits.
 *   agent — speak to an ALREADY-RUNNING agent session (type into it, read its
 *           output, adjust its runtime settings). Explicitly NOT "choose what
 *           runs" — see the honest-statement block in `@slayzone/transport/scopes`.
 *
 * The per-procedure table (`SCOPE_POLICY`) is composition data — it names every
 * router's paths — so it lives with the composition, not here; the scope gate in
 * `trpc.ts` reaches it through the registered `ProcedurePolicy` (`procedure-policy.ts`).
 */
export type Scope = 'full' | 'read' | 'tasks' | 'agent'
