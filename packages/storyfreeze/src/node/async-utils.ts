/*
 * Portions derived from storycrawler's async utilities and timer.
 * Copyright (c) 2019 reg-viz. Licensed under the MIT License.
 * Source: https://github.com/reg-viz/storycap/tree/master/packages/storycrawler
 */

export async function sleep(msec = 0): Promise<void> {
  await Promise.resolve();
  if (msec <= 0) return;
  await new Promise<void>(resolve => setTimeout(resolve, msec));
}

export type TimeoutRaceResult<T> = { timedOut: false; value: T } | { timedOut: true };

export function raceAgainstTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TimeoutRaceResult<T>> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      action();
    };
    onAbort = () => finish(() => reject(signal?.reason));
    if (Number.isFinite(timeoutMs)) {
      timeout = setTimeout(() => finish(() => resolve({ timedOut: true })), Math.max(0, timeoutMs));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => finish(() => resolve({ timedOut: false, value })),
      error => finish(() => reject(error)),
    );
  });
}

export async function time<T>(target: Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  const result = await target;
  return [result, Date.now() - start];
}

export type Task<T, Worker> = (worker: Worker) => Promise<T>;

export interface QueueController<Request> {
  push(request: Request): void;
  close(): void;
}

export type QueueOptions<Request, Result, Worker> = {
  initialRequests?: Iterable<Request>;
  createTask(request: Request, controller: QueueController<Request>): Task<Result, Worker>;
  allowEmpty?: boolean;
};

const cancellationToken = Symbol('cancel');

export class Queue<Request, Result, Worker> {
  private requestIdCounter = 0;
  private shouldContinue = true;
  private readonly futureRequests: Array<Promise<Request>> = [];
  private readonly resolvers: Array<{ resolve(request: Request): void; cancel(): void }> = [];
  private readonly requestingIds = new Set<string>();
  private readonly allowEmpty: boolean;
  private readonly createDelegationTask: QueueOptions<Request, Result, Worker>['createTask'];

  constructor({ initialRequests, createTask, allowEmpty }: QueueOptions<Request, Result, Worker>) {
    this.createDelegationTask = createTask;
    this.allowEmpty = !!allowEmpty;
    if (initialRequests) {
      for (const request of initialRequests) this.push(request);
    }
  }

  push(request: Request): void {
    const resolver = this.resolvers.shift();
    if (resolver) resolver.resolve(request);
    else this.futureRequests.push(Promise.resolve(request));
  }

  close(): void {
    this.shouldContinue = false;
    this.resolvers.forEach(({ cancel }) => cancel());
  }

  async *tasks(): AsyncGenerator<Task<Result, Worker>, void> {
    const controller = this.publishController();
    while (this.shouldContinue && (this.allowEmpty || this.futureRequests.length || this.requestingIds.size)) {
      if (this.futureRequests.length === 0) {
        this.futureRequests.push(
          new Promise<Request>((resolve, reject) => {
            this.resolvers.push({ resolve, cancel: () => reject(cancellationToken) });
          }),
        );
      }

      const futureRequest = this.futureRequests.shift()!;
      try {
        const request = await futureRequest;
        yield this.createTask(request, controller);
      } catch (reason) {
        if (reason !== cancellationToken) throw reason;
      }
    }
  }

  publishController(): QueueController<Request> {
    return {
      push: this.push.bind(this),
      close: async () => {
        await Promise.resolve();
        this.close();
      },
    };
  }

  private createTask(request: Request, controller: QueueController<Request>): Task<Result, Worker> {
    const delegate = this.createDelegationTask(request, controller);
    const requestId = `request_${++this.requestIdCounter}`;
    this.requestingIds.add(requestId);
    return async worker => {
      const result = await delegate(worker);
      this.requestingIds.delete(requestId);
      if (!this.allowEmpty && this.requestingIds.size === 0 && this.futureRequests.length === 0) this.close();
      return result;
    };
  }
}

async function runParallel<Result, Worker>(
  tasks: () => AsyncGenerator<Task<Result, Worker>, void>,
  workers: Worker[],
): Promise<Result[]> {
  if (workers.length === 0) throw new Error('No workers');
  const results: Result[] = [];
  const generator = tasks();

  await Promise.all(
    workers.map(
      worker =>
        new Promise<void>((resolve, reject) => {
          async function next(): Promise<void> {
            const { done, value: task } = await generator.next();
            if (done || !task) return resolve();
            try {
              results.push(await task(worker));
              await next();
            } catch (error) {
              reject(error);
            }
          }
          void next();
        }),
    ),
  );
  return results;
}

export type CreateExecutionServiceOptions = { allowEmpty?: boolean };

export interface ExecutionService<Request, Result> extends QueueController<Request> {
  execute(): Promise<Result[]>;
}

export function createExecutionService<Request, Result, Worker>(
  workers: Worker[],
  initialRequests: Iterable<Request>,
  createTask: (request: Request, controller: QueueController<Request>) => Task<Result, Worker>,
  options: CreateExecutionServiceOptions = {},
): ExecutionService<Request, Result> {
  const queue = new Queue({ initialRequests, createTask, allowEmpty: !!options.allowEmpty });
  return {
    execute: () => runParallel(queue.tasks.bind(queue), workers),
    ...queue.publishController(),
  };
}
