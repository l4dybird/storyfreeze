import fixturePreview from '../.storybook/preview.js';
import storyfreezePreview from '../../../packages/storyfreeze/dist/storybook/preview.js';

/** @type { import('@storybook/react-vite').Preview } */
const preview = {
  ...storyfreezePreview,
  ...fixturePreview,
  decorators: [...(storyfreezePreview.decorators ?? []), ...(fixturePreview.decorators ?? [])],
  afterEach: [...(storyfreezePreview.afterEach ?? []), ...(fixturePreview.afterEach ?? [])],
};

export default preview;
