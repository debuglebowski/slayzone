import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

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
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-hotkeys-hook',
              message: 'Use useGuardedHotkeys from @slayzone/ui instead.'
            }
          ]
        }
      ],
      // Project-wide overrides: silence stylistic / opt-in rules,
      // keep real bug-finding rules.
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      'react/no-unescaped-entities': 'off',
      'react/prop-types': 'off',
      'react-refresh/only-export-components': 'off',
      // Intentional patterns in this codebase
      'no-empty-pattern': 'off', // playwright fixture pattern `({}) => {}`
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-empty-function': [
        'error',
        { allow: ['arrowFunctions', 'methods', 'constructors'] }
      ],
      // React Compiler experimental rules — warn until codebase aligned
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/static-components': 'warn'
    }
  },
  {
    files: ['**/ui/src/useGuardedHotkeys.ts'],
    rules: {
      'no-restricted-imports': 'off'
    }
  },
  {
    // Test/fixture/script files: relax rules that don't apply
    files: [
      'scripts/**/*.{js,mjs,cjs}',
      'website/scripts/**/*.{js,mjs,cjs}',
      'packages/apps/app/e2e/fixtures/**/*.{js,ts}'
    ],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off' // chrome/browser/node globals vary by fixture
    }
  },
  {
    // Unit tests + e2e specs: mock components, anonymous wrappers
    files: ['**/*.{test,spec}.{ts,tsx}', 'packages/apps/app/e2e/**/*.ts'],
    rules: {
      'react/display-name': 'off',
      '@typescript-eslint/no-empty-function': 'off'
    }
  },
  {
    // Terminal package + e2e ANSI/control-char regexes are intentional
    files: ['packages/domains/terminal/**/*.{ts,tsx}', 'packages/apps/app/e2e/**/*.ts'],
    rules: {
      'no-control-regex': 'off'
    }
  },
  eslintConfigPrettier
)
