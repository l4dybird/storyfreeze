import { fileURLToPath } from 'node:url';

/** @type { import('@storybook/react-vite').StorybookConfig } */
// Benchmark-only Storybook. Kept separate from ../.storybook so the e2e
// fixture's story set and its project-level screenshot parameters stay
// untouched: a project-level `viewports` map is deep-merged into every story by
// Storybook, which would silently add variants to the bench scenarios.
const config = {
  stories: ['../bench/**/*.stories.@(js|jsx)'],
  staticDirs: ['../public'],
  // The fixture intentionally does not depend on StoryFreeze because the
  // compatibility E2E installs a packed tarball. Bench builds instead consume
  // the current workspace package explicitly, so a clean checkout does not
  // require an untracked node_modules junction.
  addons: [fileURLToPath(new URL('../../../packages/storyfreeze/dist/storybook/preset.js', import.meta.url))],
  framework: '@storybook/react-vite',
};

export default config;
