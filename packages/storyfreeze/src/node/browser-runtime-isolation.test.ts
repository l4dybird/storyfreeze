import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('puppeteer-core', () => {
  throw new Error('Playwright loaded the Puppeteer runtime');
});

describe('browser runtime isolation', () => {
  it('imports the CLI and Playwright backend without loading puppeteer-core', async () => {
    await expect(import('./cli-command.js')).resolves.toBeDefined();
    await expect(import('./playwright-browser-backend.js')).resolves.toMatchObject({
      playwrightBrowserBackend: { name: 'playwright' },
    });
  });
});
