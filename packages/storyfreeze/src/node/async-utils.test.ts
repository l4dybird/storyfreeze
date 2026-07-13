import { describe, expect, it, vi } from 'vite-plus/test';
import { createExecutionService } from './async-utils.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe(createExecutionService, () => {
  it('stops assigning queued work and drains in-flight work before rejecting', async () => {
    const slowStarted = deferred();
    const releaseSlow = deferred();
    const executed: string[] = [];
    const service = createExecutionService(
      ['first', 'second'],
      ['fail', 'slow', 'queued-a', 'queued-b'],
      (request, { push }) =>
        async () => {
          executed.push(request);
          if (request === 'fail') {
            await slowStarted.promise;
            throw new Error('first failure');
          }
          if (request === 'slow') {
            slowStarted.resolve();
            await releaseSlow.promise;
            push('late');
            return request;
          }
          return request;
        },
    );

    const outcome = service.execute().then(
      () => 'resolved',
      error => error,
    );
    await slowStarted.promise;
    await vi.waitFor(() => expect(executed).toEqual(['fail', 'slow']));
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSlow.resolve();
    await expect(outcome).resolves.toEqual(expect.objectContaining({ message: 'first failure' }));
    expect(executed).toEqual(['fail', 'slow']);
  });

  it('keeps the first error when another in-flight task also fails', async () => {
    const secondStarted = deferred();
    const releaseSecond = deferred();
    const service = createExecutionService(['first', 'second'], ['first', 'second'], request => async () => {
      if (request === 'first') {
        await secondStarted.promise;
        throw new Error('first failure');
      }
      secondStarted.resolve();
      await releaseSecond.promise;
      throw new Error('second failure');
    });

    const execution = service.execute();
    await secondStarted.promise;
    releaseSecond.resolve();

    await expect(execution).rejects.toThrow('first failure');
  });
});
