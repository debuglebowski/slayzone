import { defineConfig } from '@playwright/test'

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  testDir: './e2e',
  timeout: 30_000,
  // 5s = Playwright's standard default. The previous 2s was too tight for this
  // shared-window Electron suite: under machine load (e.g. a concurrent dev app)
  // assertions/polls without an explicit timeout flaked widely — board refetch
  // churn, git-merge completion polls, banner paints — all real conditions that
  // just need a realistic window. Specs that need longer still set it inline
  // (e.g. { timeout: 10_000 }). retries stays 0 — fix flakes, don't mask them.
  expect: { timeout: 5_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  use: {
    actionTimeout: 5_000,
    trace: 'on-first-retry'
  },
  testIgnore: ['**/.e2e-runtime/**', '**/packages/packages/**'],
  projects: [
    {
      name: 'electron',
      testMatch: '**/*.spec.ts'
    }
  ]
})
