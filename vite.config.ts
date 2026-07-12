import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/storyfreeze/src/**/__tests__/*.{ts,tsx}',
      'packages/storyfreeze/src/**/*.test.{ts,tsx}',
    ],
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
