import { describe, expect, it, vi } from 'vite-plus/test';
import { PlaywrightRuntime } from './playwright-runtime.js';

const playwright = vi.hoisted(() => ({
  executablePath: vi.fn(() => process.execPath),
  launch: vi.fn(),
}));

vi.mock('playwright-core', () => ({
  chromium: playwright,
}));

function runtimeFixture() {
  let connected = true;
  const cdp = { send: vi.fn(async () => ({})) };
  const page = {
    exposeFunction: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
    setViewportSize: vi.fn(async () => {}),
  };
  const context = {
    close: vi.fn(async () => {}),
    newCDPSession: vi.fn(async () => cdp),
    newPage: vi.fn(async () => page),
  };
  const browser = {
    close: vi.fn(async () => {
      connected = false;
    }),
    isConnected: vi.fn(() => connected),
    newContext: vi.fn(async () => context),
  };
  playwright.launch.mockReset().mockResolvedValue(browser);
  playwright.executablePath.mockReset().mockReturnValue(process.execPath);
  return { browser, cdp, context, page };
}

describe(PlaywrightRuntime, () => {
  it('waits for an in-flight launch and closes the browser created after close began', async () => {
    const fixture = runtimeFixture();
    let releaseLaunch = () => {};
    const launchGate = new Promise<void>(resolve => (releaseLaunch = resolve));
    playwright.launch.mockImplementation(async () => {
      await launchGate;
      return fixture.browser;
    });
    const runtime = new PlaywrightRuntime({});
    const booting = runtime.boot();
    await vi.waitFor(() => expect(playwright.launch).toHaveBeenCalledOnce());

    let closeSettled = false;
    const closing = runtime.close().then(() => (closeSettled = true));
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseLaunch();

    await expect(booting).rejects.toThrow('superseded by close');
    await closing;
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  });

  it('forwards every explicit Playwright launch option while owning the resolved executable path', async () => {
    runtimeFixture();
    const runtime = new PlaywrightRuntime({
      launchOptions: {
        args: ['--no-sandbox'],
        chromiumSandbox: false,
        headless: false,
        proxy: { server: 'http://proxy.test:8080' },
        timeout: 12_345,
      },
    });
    await runtime.boot();
    expect(playwright.launch).toHaveBeenCalledWith({
      args: ['--no-sandbox'],
      chromiumSandbox: false,
      executablePath: process.execPath,
      headless: false,
      proxy: { server: 'http://proxy.test:8080' },
      timeout: 12_345,
    });
    await runtime.close();
  });

  it('closes the context and browser when post-launch page setup fails', async () => {
    const fixture = runtimeFixture();
    class FailingRuntime extends PlaywrightRuntime {
      protected override async onBooted() {
        throw new Error('setup failed');
      }
    }
    const runtime = new FailingRuntime({});
    await expect(runtime.boot()).rejects.toThrow('setup failed');
    expect(fixture.context.close).toHaveBeenCalledOnce();
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  });

  it('recreates only the context and makes repeated close calls safe', async () => {
    const fixture = runtimeFixture();
    class TestRuntime extends PlaywrightRuntime {
      recreate() {
        return this.recreateContext({ viewport: { width: 414, height: 896, isMobile: true, hasTouch: true } });
      }
    }
    const runtime = new TestRuntime({});
    await runtime.boot({ viewport: { width: 1280, height: 720 } });
    expect(playwright.launch).toHaveBeenCalledWith({
      chromiumSandbox: true,
      executablePath: process.execPath,
      headless: true,
    });
    await runtime.recreate();
    expect(playwright.launch).toHaveBeenCalledOnce();
    expect(fixture.browser.newContext).toHaveBeenCalledTimes(2);
    expect(fixture.context.close).toHaveBeenCalledOnce();

    await Promise.all([runtime.close(), runtime.close()]);
    expect(fixture.browser.close).toHaveBeenCalledOnce();
  });
});
