import type { BrowserBackend } from './browser-backend.js';

export const lazyPlaywrightBrowserBackend: BrowserBackend = {
  name: 'playwright',
  async launch(options) {
    const { playwrightBrowserBackend } = await import('./playwright-browser-backend.js');
    return playwrightBrowserBackend.launch(options);
  },
};
