import { describe, expect, it, vi } from 'vite-plus/test';
import type {
  BrowserBackend,
  BrowserInstance,
  BrowserRuntimeOptions,
  BrowserSession,
  BrowserSessionOptions,
} from './browser-backend.js';
import { BrowserProcessCoordinator } from './browser-process-coordinator.js';

function createInstance(executablePath: string) {
  let healthy = true;
  const sessions: BrowserSession[] = [];
  const instance: BrowserInstance = {
    executablePath,
    close: vi.fn(async () => {}),
    isHealthy: () => healthy,
    newSession: vi.fn(async (_options?: BrowserSessionOptions) => {
      const session = {
        close: vi.fn(async () => {}),
        isHealthy: () => true,
        page: {},
      } as unknown as BrowserSession;
      sessions.push(session);
      return session;
    }),
  };
  return {
    instance,
    sessions,
    setHealthy(value: boolean) {
      healthy = value;
    },
  };
}

function createBackend(instances: BrowserInstance[]) {
  const launch = vi.fn(async (_options: BrowserRuntimeOptions) => {
    const instance = instances.shift();
    if (!instance) throw new Error('Unexpected browser launch.');
    return instance;
  });
  return { backend: { launch, name: 'playwright' } as BrowserBackend, launch };
}

describe(BrowserProcessCoordinator, () => {
  it('reports coordinated browser launches when diagnostics are enabled', async () => {
    vi.stubEnv('STORYFREEZE_CAPTURE_DIAGNOSTICS', '1');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const browser = createInstance('/chromium/first');
    const { backend } = createBackend([browser.instance]);
    const coordinator = new BrowserProcessCoordinator(backend, {});

    try {
      await coordinator.openSession();

      expect(write).toHaveBeenCalledWith(expect.stringContaining('"type":"browser-launch"'));
      expect(write).toHaveBeenCalledWith(expect.stringContaining('"source":"coordinator"'));
    } finally {
      await coordinator.close();
      write.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('opens many isolated sessions from one shared browser launch', async () => {
    const browser = createInstance('/chromium/first');
    const { backend, launch } = createBackend([browser.instance]);
    const coordinator = new BrowserProcessCoordinator(backend, { chromiumChannel: '*' });
    const options = { viewport: { width: 390, height: 844, deviceScaleFactor: 3 } };

    const leases = await Promise.all(Array.from({ length: 8 }, () => coordinator.openSession(options)));

    expect(launch).toHaveBeenCalledTimes(1);
    expect(browser.instance.newSession).toHaveBeenCalledTimes(8);
    expect(vi.mocked(browser.instance.newSession)).toHaveBeenCalledWith(options);
    expect(new Set(leases.map(lease => lease.generation))).toEqual(new Set([1]));
    expect(leases.every(lease => lease.executablePath === '/chromium/first')).toBe(true);
    expect(leases.every(lease => coordinator.isCurrent(lease.generation))).toBe(true);
  });

  it('serializes concurrent replacement and pins the original executable', async () => {
    const first = createInstance('/chromium/pinned');
    const second = createInstance('/chromium/replacement');
    const { backend, launch } = createBackend([first.instance, second.instance]);
    const runtimeOptions = { chromiumChannel: 'stable' as const, launchOptions: { headless: true } };
    const coordinator = new BrowserProcessCoordinator(backend, runtimeOptions);
    const original = await coordinator.openSession();
    first.setHealthy(false);

    const replacements = await Promise.all(Array.from({ length: 6 }, () => coordinator.openSession()));

    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenNthCalledWith(1, runtimeOptions);
    expect(launch).toHaveBeenNthCalledWith(2, { ...runtimeOptions, chromiumPath: '/chromium/pinned' });
    expect(first.instance.close).toHaveBeenCalledTimes(1);
    expect(coordinator.isCurrent(original.generation)).toBe(false);
    expect(new Set(replacements.map(lease => lease.generation))).toEqual(new Set([2]));
  });

  it('closes the shared browser exactly once', async () => {
    const browser = createInstance('/chromium/first');
    const { backend } = createBackend([browser.instance]);
    const coordinator = new BrowserProcessCoordinator(backend, {});
    const lease = await coordinator.openSession();

    await Promise.all([coordinator.close(), coordinator.close(), coordinator.close()]);

    expect(browser.instance.close).toHaveBeenCalledTimes(1);
    expect(coordinator.isCurrent(lease.generation)).toBe(false);
    await expect(coordinator.openSession()).rejects.toThrow('coordinator is closed');
  });
});
