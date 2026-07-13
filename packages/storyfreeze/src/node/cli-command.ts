import { readFileSync } from 'node:fs';
import {
  cli as gunshiCli,
  define,
  isArgsValidationError,
  isCommandNotFoundError,
  type CliOptions,
  type Command,
  type CommandContext,
} from 'gunshi';
import { renderHeader } from 'gunshi/renderer';
import { time } from './async-utils.js';
import { puppeteerBrowserBackend } from './browser.js';
import { browserDeviceDescriptors } from './browser-device-registry.js';
import {
  browserBackendNames,
  type BrowserBackend,
  type BrowserBackendName,
  type BrowserLaunchOptions,
  type ChromeChannel,
} from './browser-backend.js';
import { Logger } from './logger.js';
import { main } from './main.js';
import { parseShardOptions } from './shard-utilities.js';
import type { BrowserIsolationMode, MainOptions } from './types.js';

const packageVersion = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

const defaultBrowserLaunchOptions = '{}';
const chromiumChannels = ['puppeteer', 'canary', 'stable', '*'] as const;
const browserIsolationModes = ['process', 'context'] as const;

const storyfreezeCommandArgs = {
  'storybook-url': {
    type: 'positional',
    required: false,
    default: 'http://localhost:9001',
    description: 'Storybook URL.',
  },
  outDir: { type: 'string', short: 'o', default: '__screenshots__', description: 'Output directory.' },
  parallel: { type: 'number', short: 'p', default: 4, description: 'Number of browsers to screenshot.' },
  flat: { type: 'boolean', short: 'f', default: false, description: 'Flatten output filename.' },
  include: { type: 'string', short: 'i', multiple: true, description: 'Including stories name rule.' },
  exclude: { type: 'string', short: 'e', multiple: true, description: 'Excluding stories name rule.' },
  delay: { type: 'number', default: 0, description: 'Waiting time [msec] before screenshot for each story.' },
  viewport: { type: 'string', short: 'V', multiple: true, description: 'Viewport. (default: 800x600)' },
  disableCssAnimation: {
    type: 'boolean',
    default: true,
    negatable: true,
    description: 'Disable CSS animation and transition.',
  },
  disableWaitAssets: {
    type: 'boolean',
    default: false,
    description: 'Disable waiting for requested assets.',
  },
  trace: { type: 'boolean', default: false, description: 'Emit Chromium trace files per screenshot.' },
  silent: { type: 'boolean', default: false, description: 'Suppress StoryFreeze output.' },
  verbose: { type: 'boolean', default: false, description: 'Enable verbose StoryFreeze output.' },
  forwardConsoleLogs: {
    type: 'boolean',
    default: false,
    description: "Forward in-page console logs to the user's console.",
  },
  serverCmd: { type: 'string', default: '', description: 'Command line to launch Storybook server.' },
  serverTimeout: {
    type: 'number',
    default: 60_000,
    description: 'Timeout [msec] for starting Storybook server.',
  },
  shard: {
    type: 'string',
    default: '1/1',
    description:
      'The sharding options for this run. In the format <shardNumber>/<totalShards>. <shardNumber> is a number between 1 and <totalShards>. <totalShards> is the total number of computers working.',
  },
  captureTimeout: { type: 'number', default: 5_000, description: 'Timeout [msec] for capturing a story.' },
  captureMaxRetryCount: { type: 'number', default: 3, description: 'Number of times to retry capture.' },
  metricsWatchRetryCount: {
    type: 'number',
    default: 1000,
    description: 'Number of times to retry until browser metrics are stable.',
  },
  viewportDelay: {
    type: 'number',
    default: 0,
    description: 'Delay time [msec] between changing viewport and capturing.',
  },
  reloadAfterChangeViewport: {
    type: 'boolean',
    default: false,
    description: 'Whether to reload after viewport changed.',
  },
  stateChangeDelay: {
    type: 'number',
    default: 0,
    description: "Delay time [msec] after changing element's state.",
  },
  listDevices: { type: 'boolean', default: false, description: 'List available device descriptors.' },
  chromiumChannel: {
    type: 'enum',
    short: 'C',
    choices: chromiumChannels,
    default: '*',
    description: 'Channel to search local Chromium.',
  },
  chromiumPath: { type: 'string', default: '', description: 'Executable Chromium path.' },
  browserBackend: {
    type: 'enum',
    choices: browserBackendNames,
    default: 'playwright',
    description: 'Browser automation backend.',
  },
  browserIsolation: {
    type: 'enum',
    choices: browserIsolationModes,
    default: 'process',
    description: 'Browser isolation mode for capture workers.',
  },
  browserLaunchOptions: {
    type: 'string',
    description: `JSON string of browser launch options. (default: ${defaultBrowserLaunchOptions})`,
  },
  puppeteerLaunchConfig: {
    type: 'string',
    description: 'Deprecated alias for --browser-launch-options.',
  },
} as const;

export interface StoryfreezeCliValues {
  storybookUrl: string;
  outDir: string;
  parallel: number;
  flat: boolean;
  include?: string[];
  exclude?: string[];
  delay: number;
  viewport?: string[];
  disableCssAnimation: boolean;
  disableWaitAssets: boolean;
  trace: boolean;
  silent: boolean;
  verbose: boolean;
  forwardConsoleLogs: boolean;
  serverCmd: string;
  serverTimeout: number;
  shard: string;
  captureTimeout: number;
  captureMaxRetryCount: number;
  metricsWatchRetryCount: number;
  viewportDelay: number;
  reloadAfterChangeViewport: boolean;
  stateChangeDelay: number;
  listDevices: boolean;
  chromiumChannel: ChromeChannel;
  chromiumPath: string;
  browserBackend: BrowserBackendName;
  browserIsolation: BrowserIsolationMode;
  browserLaunchOptions?: string;
  puppeteerLaunchConfig?: string;
}

export interface SignalHost {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface CliDependencies {
  main: typeof main;
  resolveBrowserBackend(name: BrowserBackendName): Promise<BrowserBackend>;
  signalHost: SignalHost;
  env: NodeJS.ProcessEnv;
  writeError(message: string): void;
}

const defaultDependencies: CliDependencies = {
  main,
  resolveBrowserBackend: async name => {
    if (name === 'playwright') {
      return (await import('./playwright-browser-backend.js')).playwrightBrowserBackend;
    }
    return puppeteerBrowserBackend;
  },
  signalHost: process,
  env: process.env,
  writeError: message => process.stderr.write(message),
};

const booleanOptions = new Set([
  '--help',
  '-h',
  '--version',
  '-v',
  ...Object.entries(storyfreezeCommandArgs)
    .filter(([, schema]) => schema.type === 'boolean')
    .flatMap(([name, schema]) => {
      const option = `--${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
      const options = [option];
      if ('short' in schema) options.push(`-${schema.short}`);
      if ('negatable' in schema && schema.negatable) options.push(`--no-${option.slice(2)}`);
      return options;
    }),
]);

function assertBooleanSyntax(args: string[]) {
  const invalid = args.find(arg => {
    const equalIndex = arg.indexOf('=');
    return equalIndex > 0 && booleanOptions.has(arg.slice(0, equalIndex));
  });
  if (!invalid) return;
  const option = invalid.slice(0, invalid.indexOf('='));
  throw new Error(
    `Boolean option assignments are not supported: ${invalid}. Use ${option} to enable it${
      option === '--disable-css-animation' ? ` or --no-disable-css-animation to disable it` : ''
    }.`,
  );
}

function createLogger(values: Pick<StoryfreezeCliValues, 'silent' | 'verbose'>) {
  return new Logger(values.verbose ? 'verbose' : values.silent ? 'silent' : 'normal');
}

function assertSafeInteger(name: string, value: number, minimum: number) {
  if (Number.isSafeInteger(value) && value >= minimum) return;
  throw new Error(`--${name} must be a safe integer greater than or equal to ${minimum}.`);
}

function validateNumericOptions(values: StoryfreezeCliValues) {
  assertSafeInteger('parallel', values.parallel, 1);
  assertSafeInteger('delay', values.delay, 0);
  assertSafeInteger('server-timeout', values.serverTimeout, 1);
  assertSafeInteger('capture-timeout', values.captureTimeout, 1);
  assertSafeInteger('capture-max-retry-count', values.captureMaxRetryCount, 0);
  assertSafeInteger('metrics-watch-retry-count', values.metricsWatchRetryCount, 1);
  assertSafeInteger('viewport-delay', values.viewportDelay, 0);
  assertSafeInteger('state-change-delay', values.stateChangeDelay, 0);
}

function toMainOptions(
  values: StoryfreezeCliValues,
  logger = createLogger(values),
  env: NodeJS.ProcessEnv = process.env,
): MainOptions {
  validateNumericOptions(values);
  if (values.browserLaunchOptions !== undefined && values.puppeteerLaunchConfig !== undefined) {
    throw new Error('--browser-launch-options and --puppeteer-launch-config cannot be used together.');
  }
  const parsedLaunchOptions = JSON.parse(
    values.browserLaunchOptions ?? values.puppeteerLaunchConfig ?? defaultBrowserLaunchOptions,
  ) as BrowserLaunchOptions;
  let browserIsolation = values.browserIsolation;
  if (values.trace && browserIsolation === 'context') {
    logger.warn(
      `--trace requires process browser isolation. Using --browser-isolation process with --parallel ${values.parallel}.`,
    );
    browserIsolation = 'process';
  }
  return {
    serverOptions: {
      storybookUrl: values.storybookUrl,
      serverCmd: values.serverCmd,
      serverTimeout: values.serverTimeout,
    },
    outDir: values.outDir,
    flat: values.flat,
    include: values.include ?? [],
    exclude: values.exclude ?? [],
    delay: values.delay,
    viewports: values.viewport ?? ['800x600'],
    parallel: values.parallel,
    browserIsolation,
    shard: parseShardOptions(values.shard),
    captureTimeout: values.captureTimeout,
    captureMaxRetryCount: values.captureMaxRetryCount,
    metricsWatchRetryCount: values.metricsWatchRetryCount,
    viewportDelay: values.viewportDelay,
    reloadAfterChangeViewport: values.reloadAfterChangeViewport,
    stateChangeDelay: values.stateChangeDelay,
    disableCssAnimation: values.disableCssAnimation,
    disableWaitAssets: values.disableWaitAssets,
    trace: values.trace,
    forwardConsoleLogs: values.forwardConsoleLogs,
    chromiumChannel: values.chromiumChannel,
    chromiumPath: values.chromiumPath,
    launchOptions: {
      headless: env['STORYFREEZE_SHOW'] !== 'enabled',
      ...parsedLaunchOptions,
    },
    logger,
  };
}

function logError(logger: Logger, error: unknown) {
  if (error instanceof Error) {
    logger.error(logger.level === 'verbose' ? (error.stack ?? error.message) : error.message);
  } else {
    logger.error(error);
  }
}

async function execute(values: StoryfreezeCliValues, dependencies: CliDependencies): Promise<number> {
  const logger = createLogger(values);
  if (values.listDevices) {
    browserDeviceDescriptors.forEach(device => logger.log(device.name, JSON.stringify(device.viewport)));
    return 0;
  }

  let opt: MainOptions;
  try {
    opt = toMainOptions(values, logger, dependencies.env);
  } catch (error) {
    logError(logger, error);
    return 1;
  }

  let browserBackend: BrowserBackend;
  try {
    browserBackend = await dependencies.resolveBrowserBackend(values.browserBackend);
  } catch (error) {
    logError(logger, error);
    return 1;
  }
  if (browserBackend.name === 'puppeteer' && values.browserIsolation === 'context') {
    logger.error('--browser-isolation context is only supported by the Playwright backend.');
    return 1;
  }
  if (values.puppeteerLaunchConfig !== undefined) {
    logger.warn('--puppeteer-launch-config is deprecated. Use --browser-launch-options instead.');
  }

  const { logger: _, ...rest } = opt;
  const shutdownController = new AbortController();
  let receivedSignal: NodeJS.Signals | undefined;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (shutdownController.signal.aborted) return;
    receivedSignal = signal;
    logger.warn(`Received ${signal}. Shutting down StoryFreeze.`);
    shutdownController.abort(new Error(`StoryFreeze was interrupted by ${signal}.`));
  };
  const handleSigint = () => handleSignal('SIGINT');
  const handleSigterm = () => handleSignal('SIGTERM');
  dependencies.signalHost.once('SIGINT', handleSigint);
  dependencies.signalHost.once('SIGTERM', handleSigterm);

  logger.debug('Option:', rest);
  logger.debug('Browser backend:', browserBackend.name);
  logger.debug('Browser isolation:', opt.browserIsolation);

  try {
    const [numberOfCaptured, duration] = await time(
      dependencies.main({ ...opt, signal: shutdownController.signal }, { browserBackend }),
    );
    logger.log(
      `Screenshot was ended successfully in ${logger.color.green(duration + ' msec')} capturing ${logger.color.green(
        numberOfCaptured + '',
      )} PNGs.`,
    );
    return 0;
  } catch (error) {
    logError(logger, error);
    return receivedSignal === 'SIGINT' ? 130 : receivedSignal === 'SIGTERM' ? 143 : 1;
  } finally {
    dependencies.signalHost.removeListener('SIGINT', handleSigint);
    dependencies.signalHost.removeListener('SIGTERM', handleSigterm);
  }
}

function createStoryfreezeCommand(
  dependencies: CliDependencies = defaultDependencies,
  setExitCode: (code: number) => void = () => {},
): Command {
  return define({
    name: 'storyfreeze',
    description: 'Capture screenshot images from Storybook stories via Chromium.',
    toKebab: true,
    args: storyfreezeCommandArgs,
    examples: [
      'storyfreeze http://localhost:9009',
      'storyfreeze http://localhost:9009 -V 1024x768 -V 320x568',
      'storyfreeze http://localhost:9009 -i "some-kind/a-story"',
      'storyfreeze http://example.com/your-storybook -e "**/default" -V iPad',
      'storyfreeze --server-cmd "start-storybook -p 3000" http://localhost:3000',
    ].join('\n'),
    run: async ctx => {
      if (ctx.positionals.length > 1) {
        throw new Error(`Expected at most one Storybook URL, but received ${ctx.positionals.length}.`);
      }
      const values = {
        ...ctx.values,
        storybookUrl: ctx.values['storybook-url'],
      } as unknown as StoryfreezeCliValues;
      setExitCode(await execute(values, dependencies));
    },
  });
}

export const storyfreezeCommand = createStoryfreezeCommand();

export const storyfreezeCliOptions: CliOptions = {
  name: 'storyfreeze',
  version: packageVersion,
  strict: true,
  renderHeader: async (ctx: Readonly<CommandContext>) =>
    ctx.values['silent'] ? '' : renderHeader(ctx as CommandContext),
};

function isRenderedValidationError(error: unknown): error is AggregateError {
  return (
    error instanceof AggregateError &&
    error.errors.every(item => isArgsValidationError(item) || isCommandNotFoundError(item))
  );
}

export async function runCli(args: string[], overrides: Partial<CliDependencies> = {}): Promise<number> {
  const dependencies = { ...defaultDependencies, ...overrides };
  let exitCode = 0;
  try {
    assertBooleanSyntax(args);
    await gunshiCli(
      args,
      createStoryfreezeCommand(dependencies, code => (exitCode = code)),
      storyfreezeCliOptions,
    );
    return exitCode;
  } catch (error) {
    if (!isRenderedValidationError(error)) {
      dependencies.writeError(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    return 1;
  }
}
