import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { MainOptions } from './types.js';
import { runCli, type SignalHost } from './cli-command.js';

describe(runCli, () => {
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    error.mockRestore();
  });

  it('maps the lean CLI to the fixed managed runtime', async () => {
    let received: MainOptions | undefined;
    const main = vi.fn(async (options: MainOptions) => {
      received = options;
      return 0;
    });

    await expect(runCli(['--silent'], { main })).resolves.toBe(0);

    expect(received).toMatchObject({
      serverOptions: { storybookUrl: 'http://localhost:9001' },
      outDir: '__screenshots__',
      parallel: 4,
      mode: 'managed',
      browserIsolation: 'process',
      captureProtocol: 'story-session',
      recyclingPolicy: { maxCapturesPerContext: 128, maxContextAgeMs: 0 },
      flat: false,
      include: [],
      exclude: [],
      delay: 0,
      viewportDelay: 0,
      stateChangeDelay: 0,
      reloadAfterChangeViewport: false,
      viewports: ['800x600'],
      shard: { shardNumber: 1, totalShards: 1 },
      metricsWatchRetryCount: 1000,
      trace: false,
      chromiumChannel: '*',
      chromiumPath: '',
    });
    expect(received?.logger.level).toBe('silent');
    expect(received?.launchOptions).toEqual({ headless: true });
    expect(main).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ browserBackend: expect.objectContaining({ name: 'playwright' }) }),
    );
  });

  it('supports retained short options and repeated values', async () => {
    let received: MainOptions | undefined;
    const main = vi.fn(async (options: MainOptions) => {
      received = options;
      return 2;
    });

    await expect(
      runCli(
        [
          'https://example.test',
          '--silent',
          '-o',
          'shots',
          '-p',
          '2',
          '-f',
          '-i',
          'Button/**',
          '-i',
          'Form/**',
          '-e',
          '**/Skip',
          '-V',
          '1024x768',
          '-V',
          'iPad',
          '-C',
          'stable',
        ],
        { main },
      ),
    ).resolves.toBe(0);
    expect(received).toMatchObject({
      serverOptions: { storybookUrl: 'https://example.test' },
      outDir: 'shots',
      parallel: 2,
      flat: true,
      include: ['Button/**', 'Form/**'],
      exclude: ['**/Skip'],
      viewports: ['1024x768', 'iPad'],
      chromiumChannel: 'stable',
    });
  });

  it('maps retained long options and preserves verbose precedence', async () => {
    let received: MainOptions | undefined;
    const main = vi.fn(async (options: MainOptions) => {
      received = options;
      return 0;
    });

    await expect(
      runCli(
        [
          '--silent',
          '--verbose',
          '--capture-timeout',
          '456',
          '--capture-max-retry-count',
          '7',
          '--forward-console-logs',
          '--disable-wait-assets',
          '--browser-launch-options',
          '{"args":["--custom"],"headless":false}',
        ],
        { main },
      ),
    ).resolves.toBe(0);

    expect(received).toMatchObject({
      captureTimeout: 456,
      captureMaxRetryCount: 7,
      forwardConsoleLogs: true,
      disableWaitAssets: true,
      launchOptions: { args: ['--custom'], headless: false },
    });
    expect(received?.logger.level).toBe('verbose');
  });

  it('supports the negated default-true boolean', async () => {
    let received: MainOptions | undefined;
    const main = vi.fn(async (options: MainOptions) => {
      received = options;
      return 0;
    });

    await expect(runCli(['--silent', '--no-disable-css-animation'], { main })).resolves.toBe(0);
    expect(received?.disableCssAnimation).toBe(false);
  });

  it.each([
    '--mode',
    '--capture-protocol',
    '--browser-isolation',
    '--trace',
    '--server-cmd',
    '--server-timeout',
    '--metrics-watch-retry-count',
    '--viewport-delay',
    '--reload-after-change-viewport',
    '--state-change-delay',
    '--max-captures-per-context',
    '--max-context-age',
    '--list-devices',
  ])('rejects removed option %s', async option => {
    const main = vi.fn(async (_options: MainOptions) => 0);
    await expect(runCli([option], { main })).resolves.toBe(1);
    expect(main).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy camelCase option', ['--captureTimeout', '123']],
    ['unknown option', ['--unknown-option']],
    ['invalid number', ['--parallel', 'many']],
    ['invalid channel', ['--chromium-channel', 'nightly']],
  ])('rejects %s before execution', async (_label, args) => {
    const main = vi.fn(async (_options: MainOptions) => 0);
    await expect(runCli(args, { main })).resolves.toBe(1);
    expect(main).not.toHaveBeenCalled();
  });

  it.each(['--flat=false', '-f=false', '--no-disable-css-animation=true', '--help=false'])(
    'rejects boolean assignment syntax %s without execution',
    async assignment => {
      const main = vi.fn(async (_options: MainOptions) => 0);
      const writeError = vi.fn((_message: string) => {});

      await expect(runCli([assignment], { main, writeError })).resolves.toBe(1);
      expect(main).not.toHaveBeenCalled();
      expect(writeError).toHaveBeenCalledWith(expect.stringContaining('Boolean option assignments are not supported'));
    },
  );

  it.each([
    ['invalid shard', ['--silent', '--shard', '2/1']],
    ['invalid browser launch JSON', ['--silent', '--browser-launch-options', '{']],
    ['extra positional', ['--silent', 'https://one.test', 'https://two.test']],
  ])('returns 1 for %s', async (_label, args) => {
    const main = vi.fn(async (_options: MainOptions) => 0);
    const writeError = vi.fn((_message: string) => {});

    await expect(runCli(args, { main, writeError })).resolves.toBe(1);
    expect(main).not.toHaveBeenCalled();
  });

  it.each([
    ['fractional parallelism', ['--parallel=1.5'], '--parallel'],
    ['zero parallelism', ['--parallel=0'], '--parallel'],
    ['negative delay', ['--delay=-1'], '--delay'],
    ['zero capture timeout', ['--capture-timeout=0'], '--capture-timeout'],
    ['negative retry count', ['--capture-max-retry-count=-1'], '--capture-max-retry-count'],
  ])('rejects %s before starting the browser', async (_label, args, option) => {
    const main = vi.fn(async (_options: MainOptions) => 0);

    await expect(runCli(args, { main })).resolves.toBe(1);
    expect(main).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(' ')).toContain(option);
  });

  it('prints semantic errors once', async () => {
    const main = vi.fn(async (_options: MainOptions) => 0);
    await expect(runCli(['--shard', '2/1'], { main })).resolves.toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('maps %s to exit code %i and removes listeners', async (signal, expectedCode) => {
    const signalHost = new EventEmitter();
    let received: MainOptions | undefined;
    const main = vi.fn(
      (options: MainOptions) =>
        new Promise<number>((_resolve, reject) => {
          received = options;
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        }),
    );

    const running = runCli(['--silent'], { main, signalHost: signalHost as SignalHost });
    while (main.mock.calls.length === 0) await new Promise(resolve => setImmediate(resolve));
    signalHost.emit(signal);

    await expect(running).resolves.toBe(expectedCode);
    expect(received?.signal?.aborted).toBe(true);
    expect(signalHost.listenerCount('SIGINT')).toBe(0);
    expect(signalHost.listenerCount('SIGTERM')).toBe(0);
  });

  it.each([['--help'], ['--version']])('handles %s without calling main', async option => {
    const main = vi.fn(async (_options: MainOptions) => 0);
    await expect(runCli([option], { main })).resolves.toBe(0);
    expect(main).not.toHaveBeenCalled();
  });
});
