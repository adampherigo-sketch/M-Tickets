import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/tests/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'db',
          environment: 'node',
          include: ['packages/*/tests/db/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
})
