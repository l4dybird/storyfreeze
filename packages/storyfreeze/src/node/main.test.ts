import { describe, expect, it, vi } from 'vite-plus/test';
import { bootCaptureWorkers, filterStories } from './main.js';

describe(filterStories, () => {
  const stories = [
    { id: 'button--primary', title: 'Button', name: 'Primary' },
    { id: 'button--secondary', title: 'Button', name: 'Secondary' },
    { id: 'form--input', title: 'Form', name: 'Input' },
  ];

  it('applies include and exclude patterns without changing deterministic index order', () => {
    expect(filterStories(stories, ['Button/**'], ['**/Secondary']).map(story => story.id)).toEqual(['button--primary']);
  });
});

describe(bootCaptureWorkers, () => {
  it('collects every boot result and closes delayed successes after the first failure', async () => {
    let release = () => {};
    const delayed = new Promise<void>(resolve => (release = resolve));
    const failingWorker = {
      boot: vi.fn(async () => Promise.reject(new Error('first failed'))),
      close: vi.fn(async () => {}),
    };
    const delayedWorker = {
      boot: vi.fn(async () => {
        await delayed;
        return delayedWorker;
      }),
      close: vi.fn(async () => {}),
    };
    const workers = [failingWorker, delayedWorker];
    const booting = bootCaptureWorkers(workers);
    await Promise.resolve();
    expect(workers[1].close).not.toHaveBeenCalled();
    release();
    await expect(booting).rejects.toThrow('first failed');
    expect(workers.every(worker => worker.close.mock.calls.length === 1)).toBe(true);
  });

  it('closes every worker when startup is aborted', async () => {
    const controller = new AbortController();
    const workers = [0, 1].map(() => {
      const worker = {
        boot: vi.fn(async () => {
          await new Promise(resolve => setImmediate(resolve));
          return worker;
        }),
        close: vi.fn(async () => {}),
      };
      return worker;
    });
    const booting = bootCaptureWorkers(workers, controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(booting).rejects.toThrow('cancelled');
    expect(workers.every(worker => worker.close.mock.calls.length === 1)).toBe(true);
  });
});
