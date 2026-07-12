import type { Viewport } from '../shared/types.js';

export type ChromeChannel = 'puppeteer' | 'canary' | 'stable' | '*';

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

export interface RequestListeners {
  finished(request: BrowserRequest): void;
  started(request: BrowserRequest): void;
}

export interface CapturePage {
  addStyleFile(path: string): Promise<void>;
  blur(selector: string): Promise<void>;
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
  screenshot(options: ScreenshotCaptureOptions): Promise<Buffer | null>;
  setViewport(viewport: Viewport): Promise<void>;
  startTrace(): Promise<void>;
  stopTrace(): Promise<Buffer>;
  subscribeConsole(listener: (message: BrowserConsoleMessage) => void): () => void;
  subscribeRequests(listeners: RequestListeners): () => void;
}

export interface BrowserSession {
  readonly page: CapturePage;
  close(): Promise<void>;
}

export interface BrowserInstance {
  readonly executablePath: string;
  close(): Promise<void>;
  newSession(): Promise<BrowserSession>;
}

export interface BrowserBackend {
  readonly name: string;
  devices(): readonly BrowserDeviceDescriptor[];
  launch(options: BrowserRuntimeOptions): Promise<BrowserInstance>;
}
