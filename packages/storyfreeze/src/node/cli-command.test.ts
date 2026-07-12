import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';
import type { MainOptions } from './types.js';
import { runCli, type SignalHost } from './cli-command.js';

describe(runCli, () => {
  let log: ReturnType<typeof jest.spyOn>;
  let error: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    error.mockRestore();
  });

  it('maps defaults to MainOptions', async () => {
    let received: MainOptions | undefined;
    const main = jest.fn(async (options: MainOptions) => {
      received = options;
      return 0;
    });

    await expect(runCli(['--silent'], { main })).resolves.toBe(0);

    expect(received).toMatchObject({
      serverOptions: {
        storybookUrl: 'http://localhost:9001',
        serverCmd: '',
        serverTimeout: 60_000,
      },
      outDir: '__screenshots__',
      parallel: 4,
      flat: false,
      include: [],
      exclude: [],
      delay: 0,
      viewports: ['800x600'],
      shard: { shardNumber: 1, totalShards: 1 },
      chromiumChannel: '*',
      chromiumPath: '',
    });
    expect(received?.logger.level).toBe('silent');
    expect(received?.launchOptions?.headless).toBe(true);
  });

  it('supports all existing short options and repeated values', async () => {
    let received: MainOptions | undefined;
    const main = jest.fn(async (options: MainOptions) => {
      received = options;
      return 2;
    });

    const code = await runCli(
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
    );

    expect(code).toBe(0);
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

  it('maps kebab-case long options and preserves verbose precedence', async () => {
    let received: MainOptions | undefined;
    const main = jest.fn(async (options: MainOptions) => {
      received = options;
      return 0;
    });

    const code = await runCli(
      [
        '--silent',
        '--verbose',
        '--server-cmd',
        'storybook dev',
        '--server-timeout',
        '1234',
        '--capture-timeout',
        '456',
        '--capture-max-retry-count',
        '7',
        '--metrics-watch-retry-count',
        '8',
        '--viewport-delay',
        '9',
        '--state-change-delay',
        '10',
        '--reload-after-change-viewport',
        '--forward-console-logs',
      ],
      { main },
    );

    expect(code).toBe(0);
    expect(received).toMatchObject({
      serverOptions: { serverCmd: 'storybook dev', serverTimeout: 1234 },
      captureTimeout: 456,
      captureMaxRetryCount: 7,
      metricsWatchRetryCount: 8,
      viewportDelay: 9,
      stateChangeDelay: 10,
      reloadAfterChangeViewport: true,
      forwardConsoleLogs: true,
    });
    expect(received?.logger.level).toBe('verbose');
  });

  it('supports the negated default-true boolean', async () => {
    let received: MainOptions | undefined;
    const main = jest.fn(async (options: MainOptions) => {
      received = options;
      return 0;
    });

    await expect(runCli(['--silent', '--no-disable-css-animation'], { main })).resolves.toBe(0);
    expect(received?.disableCssAnimation).toBe(false);
  });

  it.each([
    ['legacy camelCase option', ['--serverCmd', 'storybook dev']],
    ['unknown option', ['--unknown-option']],
    ['invalid number', ['--parallel', 'many']],
    ['invalid enum', ['--chromium-channel', 'nightly']],
  ])('rejects %s before execution', async (_label, args) => {
    const main = jest.fn(async (_options: MainOptions) => 0);
    await expect(runCli(args, { main })).resolves.toBe(1);
    expect(main).not.toHaveBeenCalled();
  });

  it.each(['--flat=false', '-f=false', '--no-disable-css-animation=true', '--help=false'])(
    'rejects boolean assignment syntax %s without executing the command',
    async assignment => {
      const main = jest.fn(async (_options: MainOptions) => 0);
      const writeError = jest.fn((_message: string) => {});

      await expect(runCli([assignment], { main, writeError })).resolves.toBe(1);

      expect(main).not.toHaveBeenCalled();
      expect(writeError).toHaveBeenCalledWith(expect.stringContaining('Boolean option assignments are not supported'));
    },
  );

  it('prints a semantic error once', async () => {
    const main = jest.fn(async (_options: MainOptions) => 0);

    await expect(runCli(['--shard', '2/1'], { main })).resolves.toBe(1);

    expect(main).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.flat().join(' ')).toContain(
      'The shard number cannot be greater than the total number of shards.',
    );
  });

  it.each([
    ['invalid shard', ['--silent', '--shard', '2/1']],
    ['invalid launch JSON', ['--silent', '--puppeteer-launch-config', '{']],
    ['extra positional', ['--silent', 'https://one.test', 'https://two.test']],
  ])('returns 1 for %s', async (_label, args) => {
    const main = jest.fn(async (_options: MainOptions) => 0);
    const writeError = jest.fn((_message: string) => {});

    await expect(runCli(args, { main, writeError })).resolves.toBe(1);
    expect(main).not.toHaveBeenCalled();
  });

  it('lists devices without calling main', async () => {
    const main = jest.fn(async (_options: MainOptions) => 0);
    const getDeviceDescriptors = jest.fn(
      () =>
        [
          {
            name: 'Test Phone',
            viewport: { width: 320, height: 640, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
          },
        ] as never,
    );

    await expect(runCli(['--list-devices'], { main, getDeviceDescriptors })).resolves.toBe(0);

    expect(main).not.toHaveBeenCalled();
    expect(getDeviceDescriptors).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join(' ')).toContain('Test Phone');
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('maps %s to exit code %i and removes listeners', async (signal, expectedCode) => {
    const signalHost = new EventEmitter();
    let received: MainOptions | undefined;
    const main = jest.fn(
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
    const main = jest.fn(async (_options: MainOptions) => 0);
    await expect(runCli([option], { main })).resolves.toBe(0);
    expect(main).not.toHaveBeenCalled();
  });
});
