import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/storyfreeze/src/**/__tests__/*.{ts,tsx}',
      'packages/storyfreeze/src/**/*.test.{ts,tsx}',
    ],
  },
  lint: {
    categories: {
      correctness: 'off',
      nursery: 'off',
      pedantic: 'off',
      perf: 'off',
      restriction: 'off',
      style: 'off',
      suspicious: 'off',
    },
    ignorePatterns: ['examples/**', 'scripts/**'],
    options: {
      typeAware: false,
      typeCheck: false,
    },
    rules: {
      'no-eval': 'error',
      'no-debugger': 'error',
      'no-console': 'error',
      'no-duplicate-imports': 'error',
      'no-var': 'error',
      'no-unsafe-finally': 'error',
      'prefer-const': 'error',
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',
      'no-use-before-define': 'error',
      'typescript/no-namespace': 'error',
    },
  },
  run: {
    tasks: {
      'build:packages': {
        command: 'pnpm --filter "./packages/**" -r run build',
        input: [
          'package.json',
          'pnpm-lock.yaml',
          'pnpm-workspace.yaml',
          'tsconfig.json',
          'packages/*/package.json',
          'packages/*/tsconfig*.json',
          'packages/*/src/**',
          'packages/*/decl/**',
        ],
        output: [{ pattern: 'packages/*/dist/**', base: 'workspace' }],
      },
    },
  },
});
