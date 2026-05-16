import { defineConfig } from '@playwright/test'

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 2_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  use: {
    actionTimeout: 5_000,
    trace: 'on-first-retry',
  },
  testIgnore: ['**/.e2e-runtime/**', '**/packages/packages/**'],
  projects: [
    {
      name: 'electron',
      testMatch: '**/*.spec.ts',
    },
  ],
})
