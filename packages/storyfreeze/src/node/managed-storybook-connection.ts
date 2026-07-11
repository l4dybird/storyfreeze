import * as childProcess from 'child_process';
import type { ChildProcess } from 'child_process';
import waitOn from 'wait-on';
import {
  InvalidUrlError,
  StorybookConnection,
  StorybookServerTimeoutError,
  type StorybookConnectionOptions,
  type StorybookConnectionStatus,
} from 'storycrawler';
import type { Logger } from './logger.js';

// Derived from storycrawler's MIT-licensed StorybookConnection implementation:
// https://github.com/reg-viz/storycrawler

const defaultShutdownTimeout = 5_000;
const exitPollInterval = 25;

type ManagedConnectionOptions = {
  shutdownTimeout?: number;
};

function waitServer(url: string, timeout: number) {
  if (!url.startsWith('http')) {
    throw new InvalidUrlError(url);
  }
  const resource = url.startsWith('https') ? url.replace(/^https/, 'https-get') : url.replace(/^http/, 'http-get');
  return new Promise<void>((resolve, reject) => {
    waitOn({ resources: [resource], timeout }, error => {
      if (!error) return resolve();
      if (error.message === 'Timeout') return reject(new StorybookServerTimeoutError(timeout));
      reject(error);
    });
  });
}

function delay(msec: number) {
  return new Promise(resolve => setTimeout(resolve, msec));
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

export class ManagedStorybookConnection extends StorybookConnection {
  private serverProcess?: ChildProcess;
  private readonly shutdownTimeout: number;

  constructor(
    private readonly serverOptions: StorybookConnectionOptions,
    private readonly managedLogger: Logger,
    options: ManagedConnectionOptions = {},
  ) {
    super(serverOptions, managedLogger);
    this.shutdownTimeout = options.shutdownTimeout ?? defaultShutdownTimeout;
  }

  private setStatus(status: StorybookConnectionStatus) {
    // Keep storycrawler's inherited public status getter in sync until the
    // dependency is replaced by StoryFreeze's own connection in Phase 1.
    Reflect.set(this, '_status', status);
  }

  async connect() {
    this.setStatus('CONNECTING');
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

    await waitServer(this.url, this.serverOptions.serverTimeout || 10_000);
    this.managedLogger.debug(this.serverOptions.serverCmd ? 'Storybook server started' : 'Found Storybook server');
    this.setStatus('CONNECTED');
    return this;
  }

  async disconnect() {
    const proc = this.serverProcess;
    this.serverProcess = undefined;
    try {
      if (proc) {
        this.managedLogger.debug('Shutdown storybook server', proc.pid);
        await terminateProcessTree(proc, this.shutdownTimeout, this.managedLogger);
      }
    } finally {
      this.setStatus('DISCONNECTED');
    }
  }
}
