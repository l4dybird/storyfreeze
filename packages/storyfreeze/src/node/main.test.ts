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
  it('starts closing immediately after the first failure and drains delayed boots', async () => {
    const events: string[] = [];
    let release = () => {};
    const delayed = new Promise<void>(resolve => (release = resolve));
    const failingWorker = {
      boot: vi.fn(async () => Promise.reject(new Error('first failed'))),
      close: vi.fn(async () => {}),
    };
    const delayedWorker = {
      boot: vi.fn(async () => {
        await delayed;
        events.push('boot completed');
        return delayedWorker;
      }),
      close: vi.fn(async () => {
        events.push('close started');
        await delayed;
        events.push('close completed');
      }),
    };
    const workers = [failingWorker, delayedWorker];
    const booting = bootCaptureWorkers(workers);
    await vi.waitFor(() => expect(workers[1].close).toHaveBeenCalledOnce());
    expect(events).toEqual(['close started']);
    release();
    await expect(booting).rejects.toThrow('first failed');
    expect(workers.every(worker => worker.close.mock.calls.length === 1)).toBe(true);
    expect(events).toEqual(['close started', 'boot completed', 'close completed']);
  });

  it('starts closing immediately when startup is aborted and then drains every boot', async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const releases: Array<() => void> = [];
    const workers = [0, 1].map(index => {
      let release = () => {};
      const delayed = new Promise<void>(resolve => (release = resolve));
      releases.push(release);
      const worker = {
        boot: vi.fn(async (_options, signal?: AbortSignal) => {
          if (signal?.aborted) throw signal.reason;
          return new Promise<typeof worker>((resolve, reject) => {
            const onAbort = () => reject(signal?.reason);
            signal?.addEventListener('abort', onAbort, { once: true });
            void delayed.then(() => {
              signal?.removeEventListener('abort', onAbort);
              if (signal?.aborted) return;
              events.push(`boot ${index}`);
              resolve(worker);
            });
          });
        }),
        close: vi.fn(async () => {
          events.push(`close ${index}`);
          await delayed;
        }),
      };
      return worker;
    });
    const booting = bootCaptureWorkers(workers, controller.signal);
    const rejection = expect(booting).rejects.toThrow('cancelled');
    controller.abort(new Error('cancelled'));
    await vi.waitFor(() => expect(workers.every(worker => worker.close.mock.calls.length === 1)).toBe(true));
    expect(events).toEqual(['close 0', 'close 1']);
    releases.forEach(release => release());
    await rejection;
    expect(workers.every(worker => worker.close.mock.calls.length === 1)).toBe(true);
    expect(events).toEqual(['close 0', 'close 1']);
    expect(workers.every(worker => worker.boot.mock.calls[0][1] === controller.signal)).toBe(true);
    expect(releases).toHaveLength(2);
  });
});
