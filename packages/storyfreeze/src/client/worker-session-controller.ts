import * as coreEvents from 'storybook/internal/core-events';
import { addons } from 'storybook/preview-api';

import {
  STORYFREEZE_PREVIEW_STATE_GLOBAL,
  STORYFREEZE_WORKER_SESSION_GLOBAL,
  STORYFREEZE_WORKER_SESSION_PROTOCOL_VERSION,
  createPreviewStateBase,
  type SelectWorkerStoryRequest,
  type SerializedError,
  type StoryFreezePreviewStateV1,
  type WorkerSessionPreviewProtocol,
  type WorkerStorySelection,
} from '../shared/preview-protocol.js';

type ChannelListener = (...args: unknown[]) => void;

export interface PreviewChannel {
  emit(eventName: string, ...args: unknown[]): void;
  off(eventName: string, listener: ChannelListener): void;
  on(eventName: string, listener: ChannelListener): void;
}

type WorkerSessionWindow = typeof window & {
  [STORYFREEZE_PREVIEW_STATE_GLOBAL]?: StoryFreezePreviewStateV1;
  [STORYFREEZE_WORKER_SESSION_GLOBAL]?: WorkerSessionPreviewProtocol;
};

type EventName =
  | 'CURRENT_STORY_WAS_SET'
  | 'PLAY_FUNCTION_THREW_EXCEPTION'
  | 'SET_CURRENT_STORY'
  | 'STORY_ERRORED'
  | 'STORY_MISSING'
  | 'STORY_THREW_EXCEPTION';

const eventFallbacks: Record<EventName, string> = {
  CURRENT_STORY_WAS_SET: 'currentStoryWasSet',
  PLAY_FUNCTION_THREW_EXCEPTION: 'playFunctionThrewException',
  SET_CURRENT_STORY: 'setCurrentStory',
  STORY_ERRORED: 'storyErrored',
  STORY_MISSING: 'storyMissing',
  STORY_THREW_EXCEPTION: 'storyThrewException',
};

export function resolveCoreEvent(events: Record<string, unknown>, name: EventName): string {
  const candidate = events[name];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : eventFallbacks[name];
}

function serializedError(error: unknown, fallback: string): SerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
  }
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    const message = value.message ?? value.description ?? value.title;
    return {
      name: typeof value.name === 'string' ? value.name : 'StorybookRenderError',
      message: typeof message === 'string' ? message : fallback,
      ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
    };
  }
  return { name: 'StorybookRenderError', message: typeof error === 'string' ? error : fallback };
}

function selectionStoryId(selection: unknown): string | undefined {
  if (!selection || typeof selection !== 'object') return undefined;
  const storyId = (selection as Record<string, unknown>).storyId;
  return typeof storyId === 'string' ? storyId : undefined;
}

function defaultChannel(): PreviewChannel | undefined {
  try {
    return addons.getChannel() as PreviewChannel;
  } catch {
    return undefined;
  }
}

export function getWorkerSessionIdentity(
  target: WorkerSessionWindow | undefined = typeof window === 'undefined' ? undefined : (window as WorkerSessionWindow),
): SelectWorkerStoryRequest | undefined {
  return target?.[STORYFREEZE_WORKER_SESSION_GLOBAL]?.current();
}

export function initializeWorkerSessionController(
  target: WorkerSessionWindow | undefined = typeof window === 'undefined' ? undefined : (window as WorkerSessionWindow),
  channel: PreviewChannel | undefined = defaultChannel(),
): WorkerSessionPreviewProtocol | undefined {
  if (!target || !channel) return undefined;
  const installed = target[STORYFREEZE_WORKER_SESSION_GLOBAL];
  if (installed) return installed;

  const eventNames = Object.fromEntries(
    Object.keys(eventFallbacks).map(name => [name, resolveCoreEvent(coreEvents, name as EventName)]),
  ) as Record<EventName, string>;
  let active: WorkerStorySelection | undefined;
  let generation = 0;
  let pending:
    | {
        request: SelectWorkerStoryRequest;
        resolve(selection: WorkerStorySelection): void;
        reject(error: Error): void;
      }
    | undefined;
  let disposed = false;
  const seenRequestIds = new Set<string>();

  const failActive = (error: unknown, fallback: string) => {
    if (!active) return;
    const serialized = serializedError(error, fallback);
    target[STORYFREEZE_PREVIEW_STATE_GLOBAL] = {
      ...createPreviewStateBase(active.storyId, active.requestId),
      status: 'error',
      error: serialized,
    };
    if (pending) {
      const reject = pending.reject;
      pending = undefined;
      reject(Object.assign(new Error(serialized.message), { name: serialized.name }));
    }
  };

  const onCurrentStoryWasSet: ChannelListener = selection => {
    if (!pending) return;
    const actualStoryId = selectionStoryId(selection);
    if (actualStoryId !== pending.request.storyId) {
      failActive(
        new Error(
          `StoryFreeze requested story ${pending.request.storyId}, but Storybook selected ${actualStoryId ?? 'unknown'}.`,
        ),
        'Storybook selected an unexpected story.',
      );
      return;
    }
    const resolve = pending.resolve;
    pending = undefined;
    resolve(active!);
  };
  const onStoryErrored: ChannelListener = error =>
    failActive(error, `Storybook failed to render story ${active?.storyId ?? 'unknown'}.`);
  const onStoryMissing: ChannelListener = storyId =>
    failActive(new Error(`Storybook could not find story ${String(storyId)}.`), 'Storybook could not find the story.');
  const onStoryThrew: ChannelListener = error =>
    failActive(error, `Story ${active?.storyId ?? 'unknown'} threw while rendering.`);

  const listeners: Array<[string, ChannelListener]> = [
    [eventNames.CURRENT_STORY_WAS_SET, onCurrentStoryWasSet],
    [eventNames.PLAY_FUNCTION_THREW_EXCEPTION, onStoryThrew],
    [eventNames.STORY_ERRORED, onStoryErrored],
    [eventNames.STORY_MISSING, onStoryMissing],
    [eventNames.STORY_THREW_EXCEPTION, onStoryThrew],
  ];
  for (const [eventName, listener] of listeners) channel.on(eventName, listener);

  const protocol: WorkerSessionPreviewProtocol = {
    protocolVersion: STORYFREEZE_WORKER_SESSION_PROTOCOL_VERSION,
    selectStory(request) {
      if (disposed) return Promise.reject(new Error('The StoryFreeze worker session has been disposed.'));
      if (!request.requestId || !request.storyId) {
        return Promise.reject(new Error('StoryFreeze worker story selection requires requestId and storyId.'));
      }
      if (pending || active) {
        return Promise.reject(new Error('A StoryFreeze worker capture is already active.'));
      }
      if (seenRequestIds.has(request.requestId)) {
        return Promise.reject(new Error(`StoryFreeze worker request ${request.requestId} has already been used.`));
      }
      seenRequestIds.add(request.requestId);
      active = { ...request, generation: ++generation };
      target[STORYFREEZE_PREVIEW_STATE_GLOBAL] = {
        ...createPreviewStateBase(request.storyId, request.requestId),
        status: 'booting',
      };
      return new Promise<WorkerStorySelection>((resolve, reject) => {
        pending = { request, resolve, reject };
        channel.emit(eventNames.SET_CURRENT_STORY, { storyId: request.storyId, viewMode: 'story' });
      });
    },
    completeCapture(requestId) {
      if (!active || active.requestId !== requestId) {
        throw new Error(
          `StoryFreeze cannot complete worker request ${requestId}; active request is ${active?.requestId ?? 'none'}.`,
        );
      }
      if (pending) throw new Error(`StoryFreeze worker request ${requestId} has not selected its story yet.`);
      active = undefined;
    },
    current: () => active,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [eventName, listener] of listeners) channel.off(eventName, listener);
      if (pending) {
        const reject = pending.reject;
        pending = undefined;
        reject(new Error('The StoryFreeze worker session was disposed during story selection.'));
      }
      active = undefined;
      delete target[STORYFREEZE_WORKER_SESSION_GLOBAL];
    },
  };
  target[STORYFREEZE_WORKER_SESSION_GLOBAL] = protocol;
  return protocol;
}
