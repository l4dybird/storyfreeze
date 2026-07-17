import type { Logger } from './logger.js';
import type { BrowserLaunchOptions, BrowserRuntimeOptions, ChromeChannel } from './browser-backend.js';
import type { StorybookConnectionOptions } from './managed-storybook-connection.js';
import type { CaptureProtocolMode } from './story-session.js';

/**
 *
 * Represents StoryFreeze mode.
 *
 **/
export type RunMode = 'simple' | 'managed';

/**
 *
 * Represents the requested StoryFreeze mode.
 *
 **/
export type PreviewMode = 'auto' | RunMode;

/**
 *
 * Selects a process/context topology preset for capture workers.
 *
 **/
export type BrowserIsolationMode = 'process' | 'context' | 'hybrid' | 'auto';

export interface RecyclingPolicy {
  maxCapturesPerContext?: number;
  maxContextAgeMs?: number;
  recycleAfterRecovery: boolean;
}

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
export interface MainOptions extends BrowserRuntimeOptions {
  signal?: AbortSignal;
  serverOptions: StorybookConnectionOptions;
  captureTimeout: number;
  captureMaxRetryCount: number;
  delay: number;
  viewports: string[];
  viewportDelay: number;
  stateChangeDelay: number;
  reloadAfterChangeViewport: boolean;
  outDir: string;
  flat: boolean;
  include: string[];
  exclude: string[];
  disableCssAnimation: boolean;
  disableWaitAssets: boolean;
  trace: boolean;
  forwardConsoleLogs: boolean;
  parallel: number;
  mode: PreviewMode;
  browserIsolation: BrowserIsolationMode;
  captureProtocol: CaptureProtocolMode;
  recyclingPolicy?: RecyclingPolicy;
  shard: ShardOptions;
  metricsWatchRetryCount: number;
  chromiumChannel: ChromeChannel;
  chromiumPath: string;
  launchOptions: BrowserLaunchOptions;
  logger: Logger;
}
