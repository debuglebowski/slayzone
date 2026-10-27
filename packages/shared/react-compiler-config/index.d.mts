import type { Plugin } from 'vite'

/** plugin-react's default include/exclude — the modules the compiler pass may touch. See index.mjs. */
export const REACT_COMPILER_INCLUDE: RegExp
export const REACT_COMPILER_EXCLUDE: RegExp

/** The React Compiler pass (@rolldown/plugin-babel + reactCompilerPreset), used next to `react()`. */
export function reactCompilerPlugin(options?: { include?: RegExp }): Promise<Plugin>

/** plugin-react's code filter: a module that cannot hold a component or hook is not compiled. */
export const REACT_COMPILER_CODE_FILTER: RegExp
