// Chromium-fork dialog orchestrator — the store-driven registry every leaf
// dialog plugs into. Mirrors the canonical app-shell/AppDialogs.tsx
// (packages/apps/app/src/renderer/src/app-shell/AppDialogs.tsx): it watches
// useDialogStore (@slayzone/settings) and lazy-mounts whichever dialog has its
// open-flag set.
//
// The canonical version receives every open-flag + data/handler as props lifted
// in App.tsx. The fork is fully store-driven instead: each dialog reads its own
// slice straight from useDialogStore, so a later task wires a dialog by adding
// ONE block here — no prop threading through HomeView.
//
// Starts EMPTY: no leaf dialogs are ported into the fork yet, so sidebar buttons
// that flip store state (e.g. openSettings / openCreateTask) currently no-op
// gracefully — the flag flips, nothing renders, until the matching dialog
// registers below. The scaffolding (lazy-mount gate + Toaster) is in place so
// registering is purely additive.
import { useRef } from 'react'
import { Toaster } from '@slayzone/ui'

// Lazy-mount gate — ported verbatim from app-shell/useLazyMounted.ts. The first
// time a dialog's open-flag is true we mount its chunk and KEEP it mounted, so
// close/reopen animations work. Leaf dialogs gate their <Suspense> block with
// `shouldMount(key, open)`.
//
// Kept here (not yet called) as the registration contract: it is referenced by
// the pattern block below so a later task uses it directly.
export function useLazyMounted(): (key: string, open: boolean) => boolean {
  const set = useRef(new Set<string>())
  return (key: string, open: boolean) => {
    if (open) set.current.add(key)
    return set.current.has(key)
  }
}

export function AppDialogs(): React.JSX.Element {
  // ── Register leaf dialogs below ──────────────────────────────────────────
  // Pattern (mirrors a canonical AppDialogs block) — uncomment + adapt once the
  // dialog component is importable from a @slayzone/* barrel (extract it into a
  // package first if it isn't, per the @slayzone/sidebar precedent):
  //
  //   const shouldMount = useLazyMounted()
  //   const createTaskOpen = useDialogStore((s) => s.createTaskOpen)
  //   return (
  //     <>
  //       {shouldMount('createTask', createTaskOpen) && (
  //         <Suspense fallback={null}>
  //           <CreateTaskDialog
  //             open={createTaskOpen}
  //             onOpenChange={(open) => {
  //               if (!open) useDialogStore.getState().closeCreateTask()
  //             }}
  //             ...
  //           />
  //         </Suspense>
  //       )}
  //       <Toaster ... />
  //     </>
  //   )
  return (
    <>
      {/* Toast surface — imported feature code calls toast(); without a mounted
          Toaster those notifications silently no-op. */}
      <Toaster position="bottom-right" theme="dark" closeButton />
    </>
  )
}
