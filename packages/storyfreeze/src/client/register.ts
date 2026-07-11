import { addons } from 'storybook/manager-api';

(window as any).__STORYFREEZE_MANAGED_MODE_REGISTERED__ = true;

addons &&
  addons.register('storyfreeze', () => {
    // nothing to do
  });
