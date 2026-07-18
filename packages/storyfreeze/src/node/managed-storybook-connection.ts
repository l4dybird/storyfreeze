import * as childProcess from 'child_process';
import type { ChildProcess } from 'child_process';
import * as http from 'node:http';
import * as https from 'node:https';
import type { Logger } from './logger.js';

// Derived from storycrawler. Copyright (c) 2019 reg-viz, MIT licensed.
// https://github.com/reg-viz/storycap/tree/master/packages/storycrawler

const defaultShutdownTimeout = 5_000;
const exitPollInterval = 25;
const serverPollInterval = 250;
const maximumRedirects = 5;

export interface StorybookConnectionOptions {
  storybookUrl: string;
  serverCmd?: string;
  serverTimeout?: number;
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
    super(`Storybook server launch timeout exceeded in ${timeout} ms.`);
    this.name = 'StorybookServerTimeoutError';
  }
}

type ManagedConnectionOptions = {
  shutdownTimeout?: number;
};

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

async function waitUntilStopped(isRunning: () => boolean, timeout: number) {
  const deadline = Date.now() + timeout;
  while (isRunning()) {
    if (Date.now() >= deadline) return false;
    await delay(exitPollInterval);
  }
  return true;
}

function isProcessGroupRunning(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function runTaskkill(pid: number, force: boolean) {
  return new Promise<void>(resolve => {
    const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
    const taskkill = childProcess.spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
    taskkill.once('error', () => resolve());
    taskkill.once('exit', () => resolve());
  });
}

async function terminateWindowsProcessTree(proc: ChildProcess, timeout: number) {
  if (!proc.pid) return;
  await runTaskkill(proc.pid, true);
  const stopped = await waitUntilStopped(() => proc.exitCode === null && proc.signalCode === null, timeout);
  if (!stopped) throw new Error(`Failed to terminate Storybook process tree ${proc.pid}.`);
}

async function terminatePosixProcessGroup(proc: ChildProcess, timeout: number, logger: Logger) {
  if (!proc.pid) return;
  signalProcessGroup(proc.pid, 'SIGTERM');
  const stopped = await waitUntilStopped(() => isProcessGroupRunning(proc.pid!), timeout);
  if (stopped) return;
  logger.debug(`Storybook server did not stop in ${timeout} msec. Force killing process group ${proc.pid}.`);
  signalProcessGroup(proc.pid, 'SIGKILL');
  const forceStopped = await waitUntilStopped(() => isProcessGroupRunning(proc.pid!), timeout);
  if (!forceStopped) throw new Error(`Failed to terminate Storybook process group ${proc.pid}.`);
}

async function terminateProcessTree(proc: ChildProcess, timeout: number, logger: Logger) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32') {
    await terminateWindowsProcessTree(proc, timeout);
  } else {
    await terminatePosixProcessGroup(proc, timeout, logger);
  }
}

export class ManagedStorybookConnection {
  private serverProcess?: ChildProcess;
  private connectController?: AbortController;
  private readonly shutdownTimeout: number;
  private connectionStatus: StorybookConnectionStatus = 'DISCONNECTED';

  constructor(
    private readonly serverOptions: StorybookConnectionOptions,
    private readonly managedLogger: Logger,
    options: ManagedConnectionOptions = {},
  ) {
    this.shutdownTimeout = options.shutdownTimeout ?? defaultShutdownTimeout;
  }

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
      if (this.serverOptions.serverCmd) {
        this.serverProcess = childProcess.spawn(this.serverOptions.serverCmd, {
          shell: true,
          detached: process.platform !== 'win32',
          stdio: this.managedLogger.level === 'verbose' ? 'inherit' : 'ignore',
          windowsHide: true,
        });
        this.managedLogger.debug('Server process created', this.serverProcess.pid);
      }

      await waitServer(this.url, this.serverOptions.serverTimeout || 10_000, connectSignal);
      this.managedLogger.debug(this.serverOptions.serverCmd ? 'Storybook server started' : 'Found Storybook server');
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
    const proc = this.serverProcess;
    this.serverProcess = undefined;
    try {
      if (proc) {
        this.managedLogger.debug('Shutdown storybook server', proc.pid);
        await terminateProcessTree(proc, this.shutdownTimeout, this.managedLogger);
      }
    } finally {
      this.connectionStatus = 'DISCONNECTED';
    }
  }
}
