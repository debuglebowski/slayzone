import { defineConfig } from 'eslint/config'
import { tsParserConfigs } from '@slayzone/eslint-ts-parser'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'

// Biome owns format + ~all lint. ESLint kept ONLY for React Compiler
// experimental rules from eslint-plugin-react-hooks v7 — biome has no
// equivalent — plus the few repo-specific bans below. No rule here needs type
// information, so TS is parsed by Babel (@slayzone/eslint-ts-parser: Babel 8's
// eslint parser, TS/TSX syntax per extension) instead of typescript-eslint, which needs the
// TypeScript 5.x JS compiler API. That keeps TypeScript 7 the only
// `typescript` in the workspace.

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
      // Gitignored local scratch (`logs/` in .gitignore): flat config does not honor
      // .gitignore, so a saved bundle or script there would fail `pnpm lint`.
      '**/logs/**',
      'convex/_generated/**',
      // Local-only chromium fork tree (gitignored, ~70GB) — flat config does
      // not honor .gitignore, and linting it OOMs + reports thousands of
      // third-party errors. CI never has this dir; the ignore is for dev runs.
      'chromium/**'
    ]
  },
  // A disable that no longer suppresses anything fails lint: it would otherwise sit
  // unnoticed and later hide a new real error on the same line. (Hook-rule disables
  // also make the React Compiler skip the whole function.)
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    }
  },
  ...tsParserConfigs,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks
    },
    rules: {
      // All cleared to zero → error. The two accepted set-state-in-effect sites carry an
      // inline disable with their reason; that disable doesn't make the React Compiler
      // skip the hook (it only honors exhaustive-deps / rules-of-hooks suppressions).
      'react-hooks/set-state-in-effect': 'error',
      'react-hooks/refs': 'error',
      'react-hooks/immutability': 'error',
      'react-hooks/purity': 'error',
      'react-hooks/preserve-manual-memoization': 'error',
      'react-hooks/static-components': 'error',
      // Owned here, not by biome's useExhaustiveDependencies (off in biome.json): React's own
      // rule, and the React Compiler honors its suppressions (a suppression makes the
      // Compiler skip that hook — prefer useEffectEvent / useStableCallback).
      'react-hooks/exhaustive-deps': 'error'
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
      'packages/apps/api/src/**/*.ts',
      'packages/shared/transport/src/**/*.ts',
      'packages/shared/trpc-server/src/**/*.ts',
      'packages/shared/db-migrations/src/**/*.ts',
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
