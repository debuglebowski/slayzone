import type { TrpcVanillaClient } from '@slayzone/transport/client'

/**
 * Window globals the app exposes to the e2e suite, declared ONCE.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `e2e/` is a single TypeScript program (tsconfig.e2e.json), so a
 * `declare global` in any spec is visible to every other spec. Before this
 * file, `__testInvoke` was declared identically in three unrelated specs
 * (core/100, core/102, core/104), and roughly six hook specs typechecked only
 * because one of those three happened to exist. Deleting or narrowing any of
 * them would have broken files that never referenced them — a coupling nothing
 * in the source made visible.
 *
 * `src/preload/index.d.ts` declares `__testInvoke` as OPTIONAL, which is
 * correct for app code: the preload only installs it under PLAYWRIGHT. That
 * file is outside this program on purpose — inside the suite the bridge is
 * always present, and making it optional here would force `?.` or a non-null
 * assertion at every call site to describe a condition that cannot occur.
 *
 * Keep SUITE-WIDE globals here. Scratch globals a single spec parks on
 * `window` inside its own `page.evaluate` closures do NOT belong here — they
 * are not part of the app's contract, and hoisting them would let one spec's
 * typo typecheck against another's declaration. Use a module-scope
 * `type FooWindow = Window & { … }` in the owning spec instead, which is the
 * idiom the hook specs already follow.
 */
declare global {
  interface Window {
    /** Test-only IPC bridge, installed by the preload under PLAYWRIGHT. */
    __testInvoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    /** Vanilla tRPC client exposed by main.tsx under PLAYWRIGHT. Typing it
     *  here is what makes the `page.evaluate` closures type-checked. */
    getTrpcVanillaClient: () => TrpcVanillaClient
  }
}

export {}
