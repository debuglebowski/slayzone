/**
 * The React Compiler setup, in ONE place, for everything that runs the renderer's
 * components:
 *   - the shipped renderer builds: packages/apps/app/electron.vite.config.ts and
 *     packages/apps/web-shell/vite.config.ts;
 *   - the vitest configs whose jsdom suites render those components:
 *     packages/apps/app/vitest.config.ts (run-all.sh's vitest groups) and the own
 *     configs of @slayzone/ui, @slayzone/markdown, @slayzone/layout and
 *     @slayzone/task-artifacts.
 *
 * Tests must run components compiled exactly as they ship. The compiler memoizes
 * derived values and JSX, so a suite running the uncompiled source never sees a
 * stale cached value or an impure render-time read that the shipped component has.
 * An option added here reaches the builds and the tests together.
 *
 * Two more places run the compiler through Babel directly, at its default options, and
 * must change with this: packages/apps/app/vite/react-compiler-worker.mjs (the dev
 * transform cache) and scripts/check-react-compiler.mjs (lint:react-compiler).
 *
 * Since @vitejs/plugin-react 6 (Vite 8) plugin-react runs no Babel: JSX and Fast
 * Refresh are Vite's Oxc transform, and the compiler is a Babel pass of its own —
 * @rolldown/plugin-babel with plugin-react's `reactCompilerPreset`. The preset
 * carries plugin-react's code filter (only modules that can hold a component or
 * hook are compiled), the client-only gate (SSR modules stay uncompiled) and the
 * react/compiler-runtime pre-bundle entry.
 */
import babel from '@rolldown/plugin-babel'
import { reactCompilerPreset } from '@vitejs/plugin-react'

/** plugin-react's default include/exclude — the modules the compiler pass may touch. */
export const REACT_COMPILER_INCLUDE = /\.[tj]sx?$/
export const REACT_COMPILER_EXCLUDE = /\/node_modules\//

/**
 * The compiler pass, used next to `react()`. `include` narrows it further — the
 * Electron dev server passes a never-matching regex to hand the pass to its cached
 * worker transform while keeping this plugin's config role (the pre-bundle entry).
 */
export function reactCompilerPlugin({ include = REACT_COMPILER_INCLUDE } = {}) {
  return babel({
    include,
    exclude: REACT_COMPILER_EXCLUDE,
    presets: [reactCompilerPreset()]
  })
}

/** plugin-react's code filter: a module that cannot hold a component or hook is not compiled. */
export const REACT_COMPILER_CODE_FILTER = reactCompilerPreset().rolldown.filter.code
