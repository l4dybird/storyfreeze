/** @type { import('@storybook/react-vite').StorybookConfig } */
// Benchmark-only Storybook. Kept separate from ../.storybook so the e2e
// fixture's story set and its project-level screenshot parameters stay
// untouched: a project-level `viewports` map is deep-merged into every story by
// Storybook, which would silently add variants to the bench scenarios.
const config = {
  stories: ['../bench/**/*.stories.@(js|jsx)'],
  staticDirs: ['../public'],
  addons: ['storyfreeze'],
  framework: '@storybook/react-vite',
};

export default config;
