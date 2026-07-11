/** @type { import('@storybook/react-vite').StorybookConfig } */
const config = {
  stories: ['../src/**/*.stories.@(js|jsx)'],
  staticDirs: ['../public'],
  addons: ['@storybook/addon-docs'],
  framework: '@storybook/react-vite',
  docs: {
    autodocs: 'tag',
  },
};

export default config;
