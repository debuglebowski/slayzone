import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'

// Biome owns format + ~all lint. ESLint kept ONLY for React Compiler
// experimental rules from eslint-plugin-react-hooks v7 — biome has no
// equivalent. typescript-eslint is loaded as a stub (all rules off) so the
// legacy `// eslint-disable-next-line @typescript-eslint/...` comments
// scattered across the codebase don't trigger "Definition for rule not
// found" errors.

const BLOCKING_SPAWN_MESSAGE =
  'Blocking child-process call in hub code: it freezes every hub connection until the child exits. Use the async variant (execFile/spawn). If it truly cannot block the hub (boot-only, CLI-only), add `// eslint-disable-next-line <rule> -- <reason>`.'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/dist-electron',
      '**/out',
      '**/build',
      '**/.vite',
      '**/.astro',
      '**/coverage',
      '**/.e2e-runtime/**',
      '**/.e2e-userdata/**',
      '.claude/worktrees/**',
      'convex/_generated/**',
      // Local-only chromium fork tree (gitignored, ~70GB) — flat config does
      // not honor .gitignore, and linting it OOMs + reports thousands of
      // third-party errors. CI never has this dir; the ignore is for dev runs.
      'chromium/**'
    ]
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': eslintPluginReactHooks
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off'
    },
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      // Cleared to zero → error, so they can't regrow under the shared warning cap.
      'react-hooks/refs': 'error',
      'react-hooks/immutability': 'error',
      'react-hooks/purity': 'error',
      'react-hooks/preserve-manual-memoization': 'error',
      'react-hooks/static-components': 'error'
    }
  },
  // Ban raw setInterval in renderer/client code — these timers fire while the
  // window is hidden and burn background CPU. Use useVisibleInterval from
  // @slayzone/ui (auto-pauses while hidden). Escape-hatch with
  // `// eslint-disable-next-line no-restricted-syntax` for the rare callers
  // whose own visibility/foreground logic supersedes the generic hook
  // (e.g. telemetry, WebGL atlas, git-diff-store).
  {
    files: [
      'packages/apps/app/src/renderer/**/*.{ts,tsx}',
      'packages/domains/*/src/client/**/*.{ts,tsx}',
      'packages/shared/ui/src/**/*.{ts,tsx}'
    ],
    ignores: [
      '**/*.test.ts',
      '**/*.test.tsx',
      // The hook itself wraps setInterval.
      'packages/shared/ui/src/use-document-visibility.ts'
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.name='setInterval'], CallExpression[callee.object.name='window'][callee.property.name='setInterval']",
          message:
            'Use useVisibleInterval from @slayzone/ui to avoid burning background CPU while the window is hidden. If the timer must fire while hidden, add `// eslint-disable-next-line no-restricted-syntax` with a comment explaining why.'
        }
      ]
    }
  },
  // Ban BLOCKING child-process calls in code the hub runs. The hub is one Node
  // event loop serving every connection: a synchronous spawn freezes all of them
  // until the child exits — computer heartbeats go unanswered, sockets drop,
  // timers fire late. On 2026-10-23 a ~20s freeze from per-turn sync `git`
  // (agent-turns listing) dropped the computer connection and 39 tabs died.
  // Use the async variant (`execFile`/`spawn` + a promise). An exception needs
  // `// eslint-disable-next-line no-restricted-imports -- <why it can't block the
  // hub>` (boot-only, CLI-only, …); the hub's stall detector
  // (`server.event_loop_stall`) catches anything that slips through anyway.
  {
    files: [
      'packages/apps/hub/src/**/*.ts',
      'packages/shared/transport/src/**/*.ts',
      'packages/shared/platform/src/**/*.ts',
      'packages/domains/*/src/server/**/*.ts'
    ],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        ...['child_process', 'node:child_process'].map((name) => ({
          name,
          importNames: ['execSync', 'execFileSync', 'spawnSync'],
          message: BLOCKING_SPAWN_MESSAGE
        }))
      ],
      'no-restricted-syntax': [
        'error',
        {
          // Namespace / default imports (`cp.execSync(...)`) dodge importNames.
          selector: 'MemberExpression[property.name=/^(execSync|execFileSync|spawnSync)$/]',
          message: BLOCKING_SPAWN_MESSAGE
        }
      ]
    }
  }
)
