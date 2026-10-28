import type { TypedEmitter } from '@slayzone/platform/events'
import type { createPtyOps } from './runtime/pty-store'
import type { PtyEventMap } from './runtime/pty-manager'

// Host deps of the `pty.*` router: the ops (built by the composition root from its
// db + task session store) and the streaming emitter its subscriptions read. The
// composition root (`apps/hub/src/composition.ts`) injects them via `setPtyDeps()`;
// a router call before that throws.
export type PtyDeps = {
  ops: ReturnType<typeof createPtyOps>
  events: TypedEmitter<PtyEventMap>
}

let ptyDeps: PtyDeps | null = null

export function setPtyDeps(deps: PtyDeps): void {
  ptyDeps = deps
}

export function getPtyDeps(): PtyDeps {
  if (!ptyDeps) throw new Error('ptyDeps not initialized — call setPtyDeps() in main host first')
  return ptyDeps
}
