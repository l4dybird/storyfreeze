import { fileURLToPath } from 'node:url';
import fixtureConfig from '../.storybook/main.js';

/** @type { import('@storybook/react-vite').StorybookConfig } */
const config = {
  ...fixtureConfig,
  // Keep the compatibility fixture's docs addon and story set, but replace the
  // package-name addon entry (installed only in packaged E2E) with the current
  // workspace preset for local A/B measurements.
  addons: [
    ...(fixtureConfig.addons ?? []).filter(addon => addon !== 'storyfreeze'),
    fileURLToPath(new URL('../../../packages/storyfreeze/dist/storybook/preset.js', import.meta.url)),
  ],
};

export default config;
