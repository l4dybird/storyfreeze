import { withScreenshot } from '../client/with-screenshot.js';
import { finalizeScreenshot, initializePreviewState } from '../client/trigger-screenshot.js';

initializePreviewState();

const preview = {
  decorators: [withScreenshot],
  afterEach: [finalizeScreenshot],
};

export default preview;
