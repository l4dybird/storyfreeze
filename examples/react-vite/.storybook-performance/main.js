/** @type { import('@storybook/react-vite').StorybookConfig } */
const config = {
  stories: ['../performance/**/*.stories.@(js|jsx)'],
  staticDirs: ['../public'],
  addons: ['storyfreeze'],
  framework: '@storybook/react-vite',
};

export default config;
