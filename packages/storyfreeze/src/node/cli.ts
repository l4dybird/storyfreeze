#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { time } from './async-utils.js';
import { getDeviceDescriptors, type ChromeChannel } from './browser.js';
import { main } from './main.js';
import type { MainOptions, ShardOptions } from './types.js';
import { Logger } from './logger.js';
import { parseShardOptions } from './shard-utilities.js';

const packageVersion = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

function showDevices(logger: Logger) {
  getDeviceDescriptors().map(device => logger.log(device.name, JSON.stringify(device.viewport)));
}

async function createOptions(): Promise<MainOptions> {
  const setting = yargs(hideBin(process.argv))
    .locale('en')
    .wrap(120)
    .version(packageVersion)
    .usage('usage: storyfreeze [options] storybook_url')
    .options({
      outDir: { string: true, alias: 'o', default: '__screenshots__', description: 'Output directory.' },
      parallel: { number: true, alias: 'p', default: 4, description: 'Number of browsers to screenshot.' },
      flat: { boolean: true, alias: 'f', default: false, description: 'Flatten output filename.' },
      include: { array: true, alias: 'i', default: [], description: 'Including stories name rule.' },
      exclude: { array: true, alias: 'e', default: [], description: 'Excluding stories name rule.' },
      delay: { number: true, default: 0, description: 'Waiting time [msec] before screenshot for each story.' },
      viewport: { array: true, alias: 'V', default: ['800x600'], description: 'Viewport.' },
      disableCssAnimation: { boolean: true, default: true, description: 'Disable CSS animation and transition.' },
      disableWaitAssets: { boolean: true, default: false, description: 'Disable waiting for requested assets' },
      trace: { boolean: true, default: false, description: 'Emit Chromium trace files per screenshot.' },
      silent: { boolean: true, default: false },
      verbose: { boolean: true, default: false },
      forwardConsoleLogs: {
        boolean: true,
        default: false,
        description: "Forward in-page console logs to the user's console.",
      },
      serverCmd: { string: true, default: '', description: 'Command line to launch Storybook server.' },
      serverTimeout: { number: true, default: 60_000, description: 'Timeout [msec] for starting Storybook server.' },
      shard: {
        string: true,
        default: '1/1',
        description:
          'The sharding options for this run. In the format <shardNumber>/<totalShards>. <shardNumber> is a number between 1 and <totalShards>. <totalShards> is the total number of computers working.',
      },
      captureTimeout: { number: true, default: 5_000, description: 'Timeout [msec] for capture a story.' },
      captureMaxRetryCount: { number: true, default: 3, description: 'Number of count to retry to capture.' },
      metricsWatchRetryCount: {
        number: true,
        default: 1000,
        description: 'Number of count to retry until browser metrics stable.',
      },
      viewportDelay: {
        number: true,
        default: 300,
        description: 'Delay time [msec] between changing viewport and capturing.',
      },
      reloadAfterChangeViewport: {
        boolean: true,
        default: false,
        description: 'Whether to reload after viewport changed.',
      },
      stateChangeDelay: { number: true, default: 0, description: "Delay time [msec] after changing element's state." },
      listDevices: { boolean: true, default: false, description: 'List available device descriptors.' },
      chromiumChannel: {
        alias: 'C',
        string: true,
        default: '*',
        description: 'Channel to search local Chromium. One of "puppeteer", "canary", "stable", "*"',
      },
      chromiumPath: { string: true, default: '', description: 'Executable Chromium path.' },
      puppeteerLaunchConfig: {
        string: true,
        default: '{ "args": ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] }',
        description: 'JSON string of launch config for Puppeteer.',
      },
    })
    .example('storyfreeze http://localhost:9009', '')
    .example('storyfreeze http://localhost:9009 -V 1024x768 -V 320x568', '')
    .example('storyfreeze http://localhost:9009 -i "some-kind/a-story"', '')
    .example('storyfreeze http://example.com/your-storybook -e "**/default" -V iPad', '')
    .example('storyfreeze --serverCmd "start-storybook -p 3000" http://localhost:3000', '');
  let storybookUrl: string;

  const argv = await setting.argv;

  if (!argv._.length) {
    storybookUrl = 'http://localhost:9001';
  } else {
    storybookUrl = `${argv._[0]}`;
  }

  const {
    outDir,
    flat,
    include,
    exclude,
    delay,
    viewport,
    parallel,
    silent,
    verbose,
    forwardConsoleLogs,
    serverTimeout,
    serverCmd,
    shard,
    captureTimeout,
    captureMaxRetryCount,
    metricsWatchRetryCount,
    viewportDelay,
    reloadAfterChangeViewport,
    stateChangeDelay,
    disableCssAnimation,
    disableWaitAssets,
    trace,
    listDevices,
    chromiumChannel,
    chromiumPath,
    puppeteerLaunchConfig: puppeteerLaunchConfigString,
  } = argv;

  const logger = new Logger(verbose ? 'verbose' : silent ? 'silent' : 'normal');

  if (listDevices) {
    showDevices(logger);
    process.exit(0);
  }

  let puppeteerLaunchConfig: string;
  try {
    puppeteerLaunchConfig = {
      headless: process.env['STORYFREEZE_SHOW'] !== 'enabled',
      ...JSON.parse(puppeteerLaunchConfigString),
    };
  } catch (error) {
    logger.error(error);
    throw error;
  }

  let shardOptions: ShardOptions;
  try {
    shardOptions = parseShardOptions(shard);
  } catch (error) {
    logger.error(error);
    throw error;
  }

  const opt = {
    serverOptions: {
      storybookUrl,
      serverCmd,
      serverTimeout,
    },
    outDir,
    flat,
    include,
    exclude,
    delay,
    viewports: viewport,
    parallel,
    shard: shardOptions,
    captureTimeout,
    captureMaxRetryCount,
    metricsWatchRetryCount,
    viewportDelay,
    reloadAfterChangeViewport,
    stateChangeDelay,
    disableCssAnimation,
    disableWaitAssets,
    trace,
    forwardConsoleLogs,
    chromiumChannel: chromiumChannel as ChromeChannel,
    chromiumPath,
    launchOptions: puppeteerLaunchConfig,
    logger,
  } as MainOptions;
  return opt;
}

async function cli() {
  const opt = await createOptions();
  const { logger, ...rest } = opt;
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
  process.once('SIGINT', handleSigint);
  process.once('SIGTERM', handleSigterm);

  logger.debug('Option:', rest);

  try {
    const [numberOfCaptured, duration] = await time(main({ ...opt, signal: shutdownController.signal }));
    logger.log(
      `Screenshot was ended successfully in ${logger.color.green(duration + ' msec')} capturing ${logger.color.green(
        numberOfCaptured + '',
      )} PNGs.`,
    );
    return 0;
  } catch (error) {
    if (error instanceof Error) {
      logger.error(error.message);
      logger.errorStack(error.stack);
    } else {
      logger.error(error);
    }
    return receivedSignal === 'SIGINT' ? 130 : receivedSignal === 'SIGTERM' ? 143 : 1;
  } finally {
    process.removeListener('SIGINT', handleSigint);
    process.removeListener('SIGTERM', handleSigterm);
  }
}

cli()
  .then(code => {
    process.exitCode = code;
  })
  .catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
