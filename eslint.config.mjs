import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

// Biome owns format + ~all lint. ESLint kept ONLY for React Compiler
// experimental rules from eslint-plugin-react-hooks v7 — biome has no
// equivalent. Other plugins are loaded as stubs (all rules off) so the
// ~120 legacy `// eslint-disable-next-line @typescript-eslint/...` /
// `// eslint-disable-next-line react/...` comments scattered across the
// codebase don't trigger "Definition for rule not found" errors.

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
      'convex/_generated/**'
    ]
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      react: eslintPluginReact,
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'off'
    },
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/static-components': 'warn'
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
  }
)
