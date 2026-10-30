// Component tests of the app: jest-expo's iOS preset (React Native's test environment and
// renderer, Expo's native-module mocks, babel-preset-expo), run in Node — no simulator.
// Platform-free logic shared with desktop keeps its vitest suites in its own package.
//
// Workspace packages resolve to their TypeScript sources outside node_modules, so jest
// transforms them like the app's own files. Registry packages are left untransformed
// except the ones the preset lists and the ESM-only ones the app reaches at runtime
// (superjson, the tRPC transformer, and its dependencies; marked, the chat's markdown
// lexer and the artifact pages' markdown parser): jest runs CommonJS.
const { transformIgnorePatterns } = require('jest-expo/ios/jest-preset')

const ESM_ONLY = ['superjson', 'copy-anything', 'is-what', 'marked']
const PRESET_ALLOWLIST_START = '/node_modules/(?!('

const [nodeModules, ...rest] = transformIgnorePatterns
if (!nodeModules.startsWith(PRESET_ALLOWLIST_START)) {
  // The preset changed its pattern's shape: extend it by hand again, don't guess.
  throw new Error(`jest-expo transformIgnorePatterns[0] changed: ${nodeModules}`)
}

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo/ios',
  transformIgnorePatterns: [
    `${PRESET_ALLOWLIST_START}${ESM_ONLY.join('|')}|${nodeModules.slice(PRESET_ALLOWLIST_START.length)}`,
    ...rest
  ],
  setupFiles: ['<rootDir>/jest.setup.js'],
  // Tests live beside the modules they test; routes (src/app) hold none.
  roots: ['<rootDir>/src'],
  // Crawl `roots` with node, not watchman: watchman watches from the repository root
  // (every package and worktree) and a test run waited on that crawl for minutes.
  watchman: false
}
