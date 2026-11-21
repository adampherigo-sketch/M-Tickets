import js from '@eslint/js'
import nextPlugin from '@next/eslint-plugin-next'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// Architecture rules enforced by lint, not by convention:
//   1. Only the Stripe adapter may import "stripe" (payment-provider seam).
//   2. The domain layer is pure TypeScript: no framework, database or provider imports.
//   3. M-Tickets never imports another module (e.g. M-Events); modules talk through domain events.
const STRIPE_ONLY_IN_ADAPTER = {
  name: 'stripe',
  message: 'Only packages/m-tickets/src/payments/stripe/ may import Stripe. Use the PaymentProvider interface.',
}
const NO_OTHER_MODULES = {
  group: ['@zevaryn/m-events', '@zevaryn/m-events/*', '@zevaryn/m-wallet', '@zevaryn/m-wallet/*'],
  message: 'Modules communicate through domain events (@zevaryn/core/events), never by importing each other.',
}

export default defineConfig([
  globalIgnores([
    '**/.next',
    '**/node_modules',
    'coverage',
    'packages/database/src/database.types.ts',
    '**/next-env.d.ts',
  ]),
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-imports': ['error', { paths: [STRIPE_ONLY_IN_ADAPTER] }],
    },
  },
  {
    files: ['packages/m-tickets/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [STRIPE_ONLY_IN_ADAPTER], patterns: [NO_OTHER_MODULES] }],
    },
  },
  {
    files: ['packages/m-tickets/src/payments/stripe/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['packages/m-tickets/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [STRIPE_ONLY_IN_ADAPTER],
          patterns: [
            {
              group: [
                'react',
                'react-dom',
                'next',
                'next/*',
                '@supabase/*',
                'zod',
                '@zevaryn/*',
                '../db',
                '../db/*',
                '../payments',
                '../payments/*',
                '../server',
                '../server/*',
                '../ui',
                '../ui/*',
              ],
              message: 'The domain layer is pure TypeScript with no framework, database or provider dependencies.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/m-tickets/src/ui/**/*.tsx', 'apps/web/src/**/*.tsx'],
    extends: [reactHooks.configs.flat['recommended-latest']],
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    rules: { ...nextPlugin.configs.recommended.rules, ...nextPlugin.configs['core-web-vitals'].rules },
    settings: { next: { rootDir: 'apps/web' } },
  },
])
