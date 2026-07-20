import type { Logger } from './logger.js';
import type { BrowserLaunchOptions, PlaywrightRuntimeOptions } from './playwright-runtime.js';
import type { ChromeChannel } from './chromium-resolver.js';
import type { StorybookConnectionOptions } from './managed-storybook-connection.js';

/**
 *
 * Parameters for sharding.
 *
 **/
export type ShardOptions = {
  shardNumber: number;
  totalShards: number;
};

/**
 *
 * Parameters for main procedure.
 * Almost all of fields are dericed CLI options.
 *
 **/
export interface MainOptions extends PlaywrightRuntimeOptions {
  signal?: AbortSignal;
  serverOptions: StorybookConnectionOptions;
  captureTimeout: number;
  captureMaxRetryCount: number;
  delay: number;
  viewports: string[];
  outDir: string;
  flat: boolean;
  include: string[];
  exclude: string[];
  disableCssAnimation: boolean;
  disableWaitAssets: boolean;
  forwardConsoleLogs: boolean;
  parallel: number;
  shard: ShardOptions;
  chromiumChannel: ChromeChannel;
  chromiumPath: string;
  launchOptions: BrowserLaunchOptions;
  logger: Logger;
}
