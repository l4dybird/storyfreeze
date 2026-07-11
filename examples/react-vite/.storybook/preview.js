import storyfreezePreview from 'storyfreeze/preview';

/** @type { import('@storybook/react-vite').Preview } */
const preview = {
  decorators: storyfreezePreview.decorators,
  afterEach: storyfreezePreview.afterEach,
  parameters: {
    screenshot: {
      viewports: {
        LARGE: {
          width: 1200,
          height: 800,
        },
        SMALL: {
          width: 375,
          height: 667,
          deviceScaleFactor: 2,
          isMobile: true,
        },
      },
    },
  },
};

export default preview;
