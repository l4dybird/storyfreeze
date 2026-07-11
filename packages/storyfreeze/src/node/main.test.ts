import { jest } from '@jest/globals';
import { StoriesBrowser } from 'storycrawler';
import { Logger } from './logger.js';
import { ManagedStorybookConnection } from './managed-storybook-connection.js';
import type { MainOptions } from './types.js';
import { disposeRuntimeResources, filterStories, main } from './main.js';
import type { StoryDescriptor } from './story-index-provider.js';

function story(id: string, title: string, name: string): StoryDescriptor {
  return { id, title, name };
}

describe(filterStories, () => {
  const stories = [
    story('button--primary', 'Button', 'Primary'),
    story('button--secondary', 'Button', 'Secondary'),
    story('form-input--default', 'Form/Input', 'Default'),
  ];

  it('preserves enumeration order when no filters are specified', () => {
    expect(filterStories(stories, [], []).map(item => item.id)).toEqual([
      'button--primary',
      'button--secondary',
      'form-input--default',
    ]);
  });

  it('applies include before exclude using the title/story name', () => {
    expect(filterStories(stories, ['Button/**'], ['**/Secondary']).map(item => item.id)).toEqual(['button--primary']);
  });
});

describe(disposeRuntimeResources, () => {
  const logger = new Logger('silent');

  it('calls and awaits worker close before disconnecting', async () => {
    let releaseWorker = () => {};
    const worker = {
      close: jest.fn(() => new Promise<void>(resolve => (releaseWorker = resolve))),
    };
    const storiesBrowser = { close: jest.fn(async () => {}) };
    const connection = { disconnect: jest.fn(async () => {}) };

    const disposing = disposeRuntimeResources({ workers: [worker], storiesBrowser, connection }, logger);
    await Promise.resolve();

    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(storiesBrowser.close).not.toHaveBeenCalled();
    expect(connection.disconnect).not.toHaveBeenCalled();

    releaseWorker();
    await disposing;

    expect(storiesBrowser.close).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  it('continues cleanup when a close operation fails', async () => {
    const worker = { close: jest.fn(async () => Promise.reject(new Error('close failed'))) };
    const storiesBrowser = { close: jest.fn(async () => {}) };
    const connection = { disconnect: jest.fn(async () => {}) };

    await expect(disposeRuntimeResources({ workers: [worker], storiesBrowser, connection }, logger)).resolves.toBe(
      undefined,
    );
    expect(storiesBrowser.close).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe(main, () => {
  const logger = new Logger('silent');
  const options = {
    logger,
    serverOptions: { storybookUrl: 'https://example.test', serverCmd: '', serverTimeout: 1000 },
    outDir: '__screenshots__',
    flat: false,
    include: [],
    exclude: [],
    shard: { shardNumber: 1, totalShards: 1 },
  } as unknown as MainOptions;

  afterEach(() => jest.restoreAllMocks());

  it('closes the enumeration browser and connection when story enumeration fails', async () => {
    jest.spyOn(ManagedStorybookConnection.prototype, 'connect').mockImplementation(async function (
      this: ManagedStorybookConnection,
    ) {
      return this;
    });
    const disconnect = jest.spyOn(ManagedStorybookConnection.prototype, 'disconnect').mockResolvedValue();
    jest.spyOn(StoriesBrowser.prototype, 'boot').mockImplementation(async function (this: StoriesBrowser) {
      return this;
    });
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('enumeration failed'));
    const close = jest.spyOn(StoriesBrowser.prototype, 'close').mockResolvedValue();

    await expect(main(options)).rejects.toThrow('enumeration failed');

    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects after an early return when no stories match', async () => {
    jest.spyOn(ManagedStorybookConnection.prototype, 'connect').mockImplementation(async function (
      this: ManagedStorybookConnection,
    ) {
      return this;
    });
    const disconnect = jest.spyOn(ManagedStorybookConnection.prototype, 'disconnect').mockResolvedValue();
    jest.spyOn(StoriesBrowser.prototype, 'boot').mockImplementation(async function (this: StoriesBrowser) {
      return this;
    });
    const getStories = jest.spyOn(StoriesBrowser.prototype, 'getStories');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ entries: {} })));
    const close = jest.spyOn(StoriesBrowser.prototype, 'close').mockResolvedValue();
    jest.spyOn(StoriesBrowser.prototype, 'page', 'get').mockReturnValue({
      goto: jest.fn(async () => {}),
      evaluate: jest.fn(async () => false),
    } as never);

    await expect(main(options)).resolves.toBe(0);

    expect(getStories).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('closes the browser and connection when interrupted during enumeration', async () => {
    const controller = new AbortController();
    jest.spyOn(ManagedStorybookConnection.prototype, 'connect').mockImplementation(async function (
      this: ManagedStorybookConnection,
    ) {
      return this;
    });
    const disconnect = jest.spyOn(ManagedStorybookConnection.prototype, 'disconnect').mockResolvedValue();
    jest.spyOn(StoriesBrowser.prototype, 'boot').mockImplementation(async function (this: StoriesBrowser) {
      return this;
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    const close = jest.spyOn(StoriesBrowser.prototype, 'close').mockResolvedValue();

    const running = main({ ...options, signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new Error('interrupted by test'));

    await expect(running).rejects.toThrow('interrupted by test');
    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
