import base from './packages/shared/test-utils/vitest.harness.config'
export default {
  ...base,
  test: {
    ...base.test,
    exclude: ['**/node_modules/**', '**/dist/**'],
    globalSetup: [],
    maxWorkers: 2
  }
}
