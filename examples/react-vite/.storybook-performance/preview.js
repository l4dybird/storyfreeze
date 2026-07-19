/** @type { import('@storybook/react-vite').Preview } */
const preview = {
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        desktop: { styles: { width: '1280px', height: '720px' } },
        mobile: { styles: { width: '414px', height: '896px' } },
      },
    },
  },
};

export default preview;
