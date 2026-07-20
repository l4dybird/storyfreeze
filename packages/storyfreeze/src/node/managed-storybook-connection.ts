import * as http from 'node:http';
import * as https from 'node:https';
import type { Logger } from './logger.js';

// Derived from storycrawler. Copyright (c) 2019 reg-viz, MIT licensed.
// https://github.com/reg-viz/storycap/tree/master/packages/storycrawler

const connectionTimeout = 10_000;
const serverPollInterval = 250;
const maximumRedirects = 5;

export interface StorybookConnectionOptions {
  storybookUrl: string;
}

export type StorybookConnectionStatus = 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED';

export class InvalidUrlError extends Error {
  constructor(invalidUrl: string) {
    super(`The URL ${invalidUrl} is invalid.`);
    this.name = 'InvalidUrlError';
  }
}

export class StorybookServerTimeoutError extends Error {
  constructor(timeout: number) {
    super(`Storybook connection timeout exceeded in ${timeout} ms.`);
    this.name = 'StorybookServerTimeoutError';
  }
}

function interruptionError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error('StoryFreeze was interrupted.');
}

function parseServerUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url;
  } catch {
    // Normalize malformed and unsupported URLs to the existing public error.
  }
  throw new InvalidUrlError(value);
}

function requestServer(url: URL, signal: AbortSignal, redirectCount = 0): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(
      url,
      {
        signal,
        ...(url.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      },
      response => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        response.destroy();
        if (status >= 300 && status < 400 && location && redirectCount < maximumRedirects) {
          try {
            requestServer(new URL(location, url), signal, redirectCount + 1).then(resolve, () => {
              if (signal.aborted) reject(interruptionError(signal));
              else resolve(false);
            });
          } catch {
            resolve(false);
          }
          return;
        }
        resolve(status >= 200 && status < 300);
      },
    );
    request.once('error', () => {
      if (signal.aborted) reject(interruptionError(signal));
      else resolve(false);
    });
  });
}

function delay(msec: number, signal?: AbortSignal) {
  if (!signal) return new Promise<void>(resolve => setTimeout(resolve, msec));
  if (signal.aborted) return Promise.reject(interruptionError(signal));
  return new Promise<void>((resolve, reject) => {
    const timerRef: { current?: ReturnType<typeof setTimeout> } = {};
    const onAbort = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      reject(interruptionError(signal));
    };
    timerRef.current = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, msec);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitServer(value: string, timeout: number, signal?: AbortSignal) {
  const url = parseServerUrl(value);
  const timeoutController = new AbortController();
  const waitSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  const timer = setTimeout(() => timeoutController.abort(new StorybookServerTimeoutError(timeout)), timeout);
  try {
    while (true) {
      if (waitSignal.aborted) throw interruptionError(waitSignal);
      if (await requestServer(url, waitSignal)) return;
      await delay(serverPollInterval, waitSignal);
    }
  } finally {
    clearTimeout(timer);
  }
}

export class ManagedStorybookConnection {
  private connectController?: AbortController;
  private connectionStatus: StorybookConnectionStatus = 'DISCONNECTED';

  constructor(
    private readonly serverOptions: StorybookConnectionOptions,
    private readonly managedLogger: Logger,
  ) {}

  get url() {
    return this.serverOptions.storybookUrl;
  }

  get status() {
    return this.connectionStatus;
  }

  async connect(signal?: AbortSignal) {
    if (signal?.aborted) throw interruptionError(signal);
    const connectController = new AbortController();
    this.connectController = connectController;
    const connectSignal = signal ? AbortSignal.any([signal, connectController.signal]) : connectController.signal;
    this.connectionStatus = 'CONNECTING';
    try {
      this.managedLogger.log(`Wait for connecting storybook server ${this.managedLogger.color.green(this.url)}.`);
      await waitServer(this.url, connectionTimeout, connectSignal);
      this.managedLogger.debug('Found Storybook server');
      this.connectionStatus = 'CONNECTED';
      return this;
    } catch (error) {
      this.connectionStatus = 'DISCONNECTED';
      throw error;
    } finally {
      if (this.connectController === connectController) this.connectController = undefined;
    }
  }

  async disconnect() {
    this.connectController?.abort(new Error('Storybook connection was disconnected.'));
    this.connectController = undefined;
    this.connectionStatus = 'DISCONNECTED';
  }
}
