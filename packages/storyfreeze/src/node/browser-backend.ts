import type { Viewport } from '../shared/types.js';
import type { VisualCommitOptions, VisualCommitResult } from '../shared/visual-commit.js';

export type ChromeChannel = 'canary' | 'stable' | '*';

export class ChromiumNotFoundError extends Error {
  name = 'ChromiumNotFoundError';
}

export type BrowserLaunchOptions = {
  args?: string[];
  executablePath?: string;
  headless?: boolean;
  [key: string]: unknown;
};

export interface BrowserRuntimeOptions {
  launchOptions?: BrowserLaunchOptions;
  chromiumChannel?: ChromeChannel;
  chromiumPath?: string;
}

export interface BrowserSessionOptions {
  viewport?: Viewport;
}

export interface BrowserDeviceDescriptor {
  name: string;
  viewport: Viewport;
}

export interface BrowserMetrics {
  nodes?: number;
  recalcStyleCount?: number;
  layoutCount?: number;
}

export interface BrowserRequest {
  method: string;
  resourceType: string;
  url: string;
}

export interface BrowserConsoleMessage {
  text: string;
  type: string;
}

export interface NavigationOptions {
  timeout?: number;
  waitUntil?: 'domcontentloaded';
}

export interface ScreenshotCaptureOptions {
  captureBeyondViewport?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
  fullPage?: boolean;
  omitBackground?: boolean;
}

export interface ScreenshotCaptureDimensions {
  deviceScaleFactor: number;
  height: number;
  width: number;
}

export interface ScreenshotCaptureController {
  capture(
    dimensions: ScreenshotCaptureDimensions | undefined,
    capture: () => Promise<Buffer | null>,
  ): Promise<Buffer | null>;
}

export interface RequestListeners {
  finished(request: BrowserRequest): void;
  started(request: BrowserRequest): void;
}

export interface TraceSink {
  write(chunk: Buffer): Promise<void>;
}

export interface CapturePage {
  activate(): Promise<void>;
  addStyleFile(path: string): Promise<void>;
  click(selector: string): Promise<void>;
  currentUrl(): string;
  elementExists(selector: string): Promise<boolean>;
  evaluate<Result>(fn: () => Result | Promise<Result>): Promise<Awaited<Result>>;
  evaluate<Argument, Result>(
    fn: (argument: Argument) => Result | Promise<Result>,
    argument: Argument,
  ): Promise<Awaited<Result>>;
  exposeFunction<Arguments extends unknown[], Result>(
    name: string,
    fn: (...args: Arguments) => Result | Promise<Result>,
  ): Promise<void>;
  focus(selector: string): Promise<void>;
  goto(url: string, options?: NavigationOptions): Promise<void>;
  hover(selector: string): Promise<void>;
  readMetrics(): Promise<BrowserMetrics>;
  resetPointer(): Promise<void>;
  screenshot(options: ScreenshotCaptureOptions, controller?: ScreenshotCaptureController): Promise<Buffer | null>;
  setViewport(viewport: Viewport): Promise<void>;
  startTrace(sink: TraceSink): Promise<void>;
  stopTrace(): Promise<void>;
  subscribeConsole(listener: (message: BrowserConsoleMessage) => void): () => void;
  subscribeRequests(listeners: RequestListeners): () => void;
  waitForRenderTick(): Promise<void>;
  waitForVisualCommit(options: VisualCommitOptions, signal?: AbortSignal): Promise<VisualCommitResult>;
}

export interface BrowserSession {
  readonly page: CapturePage;
  close(): Promise<void>;
  isHealthy(): boolean;
}

export interface BrowserInstance {
  readonly executablePath: string;
  close(): Promise<void>;
  isHealthy(): boolean;
  newSession(options?: BrowserSessionOptions): Promise<BrowserSession>;
}

export interface BrowserBackend {
  readonly name: 'playwright';
  launch(options: BrowserRuntimeOptions): Promise<BrowserInstance>;
}
