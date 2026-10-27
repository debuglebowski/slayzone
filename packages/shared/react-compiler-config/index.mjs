/**
 * The React Compiler setup for @vitejs/plugin-react, in ONE place, for everything
 * that runs the renderer's components:
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
 * The plugin is named by its package name, not a resolved path: @vitejs/plugin-react
 * recognises the compiler by that exact string (it then pre-bundles
 * react/compiler-runtime, and leaves SSR-mode transforms uncompiled). Babel resolves
 * the name from the process cwd, so each package that builds or tests with this
 * config declares babel-plugin-react-compiler in its own package.json.
 */
export function reactCompilerBabelOptions() {
  return { plugins: ['babel-plugin-react-compiler'] }
}
