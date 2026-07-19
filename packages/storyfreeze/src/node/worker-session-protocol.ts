import type { CapturePage } from './browser-backend.js';
import {
  STORYFREEZE_WORKER_SESSION_GLOBAL,
  STORYFREEZE_WORKER_SESSION_PROTOCOL_VERSION,
  type SelectWorkerStoryRequest,
  type WorkerStorySelection,
} from '../shared/preview-protocol.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSelection(value: unknown, expected: SelectWorkerStoryRequest): WorkerStorySelection {
  if (!isRecord(value)) throw new Error('Worker-session selection response must be an object.');
  if (value.requestId !== expected.requestId || value.storyId !== expected.storyId) {
    throw new Error(
      `Worker-session selection mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(value)}.`,
    );
  }
  if (!Number.isSafeInteger(value.generation) || Number(value.generation) < 1) {
    throw new Error('Worker-session selection generation must be a positive safe integer.');
  }
  return { ...expected, generation: Number(value.generation) };
}

export class WorkerSessionProtocolClient {
  private active?: WorkerStorySelection;

  constructor(private readonly page: Pick<CapturePage, 'evaluate'>) {}

  get current() {
    return this.active;
  }

  async selectStory(request: SelectWorkerStoryRequest): Promise<WorkerStorySelection> {
    if (this.active) throw new Error(`Worker-session request ${this.active.requestId} is still active.`);
    try {
      const selected = validateSelection(await this.invoke('selectStory', request), request);
      this.active = selected;
      return selected;
    } catch (error) {
      this.active = undefined;
      throw error;
    }
  }

  async completeCapture(): Promise<void> {
    const active = this.active;
    if (!active) return;
    try {
      await this.invoke('completeCapture', active.requestId);
    } finally {
      this.active = undefined;
    }
  }

  invalidate() {
    this.active = undefined;
  }

  private invoke(method: 'selectStory' | 'completeCapture', argument: unknown): Promise<unknown> {
    return this.page.evaluate(
      async ({ argument, globalName, method, protocolVersion }) => {
        const protocol = (window as unknown as Record<string, unknown>)[globalName];
        if (typeof protocol !== 'object' || protocol === null) {
          throw new Error('StoryFreeze worker-session preview protocol is unavailable or incompatible.');
        }
        const record = protocol as Record<string, unknown>;
        const handler = record[method];
        if (record.protocolVersion !== protocolVersion || typeof handler !== 'function') {
          throw new Error('StoryFreeze worker-session preview protocol is unavailable or incompatible.');
        }
        return handler.call(protocol, argument);
      },
      {
        argument,
        globalName: STORYFREEZE_WORKER_SESSION_GLOBAL,
        method,
        protocolVersion: STORYFREEZE_WORKER_SESSION_PROTOCOL_VERSION,
      },
    );
  }
}

export function isWorkerSessionProtocolUnavailable(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('worker-session preview protocol is unavailable or incompatible')
  );
}

export function isWorkerSessionProtocolFault(error: unknown): boolean {
  if (!(error instanceof Error) || isWorkerSessionProtocolUnavailable(error)) return false;
  return /(?:Worker-session selection mismatch|selection generation|request .* is still active)/i.test(error.message);
}
