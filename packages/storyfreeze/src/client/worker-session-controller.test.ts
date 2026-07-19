import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { STORYFREEZE_PREVIEW_STATE_GLOBAL, STORYFREEZE_WORKER_SESSION_GLOBAL } from '../shared/preview-protocol.js';
import {
  getWorkerSessionIdentity,
  initializeWorkerSessionController,
  resolveCoreEvent,
  type PreviewChannel,
} from './worker-session-controller.js';

class FakeChannel implements PreviewChannel {
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  emitted: Array<{ eventName: string; args: unknown[] }> = [];

  emit(eventName: string, ...args: unknown[]) {
    this.emitted.push({ eventName, args });
    for (const listener of this.listeners.get(eventName) ?? []) listener(...args);
  }

  off(eventName: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(eventName)?.delete(listener);
  }

  on(eventName: string, listener: (...args: unknown[]) => void) {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
  }
}

describe(initializeWorkerSessionController, () => {
  afterEach(() => vi.restoreAllMocks());

  it('selects stories with a correlated in-memory capture identity', async () => {
    const target = {} as typeof window;
    const channel = new FakeChannel();
    const protocol = initializeWorkerSessionController(target, channel)!;

    const selecting = protocol.selectStory({ requestId: 'worker-0-2', storyId: 'button--secondary' });
    expect(channel.emitted.at(-1)).toEqual({
      eventName: 'setCurrentStory',
      args: [{ storyId: 'button--secondary', viewMode: 'story' }],
    });
    expect(getWorkerSessionIdentity(target)).toEqual({
      requestId: 'worker-0-2',
      storyId: 'button--secondary',
      generation: 1,
    });
    expect((target as any)[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toMatchObject({
      requestId: 'worker-0-2',
      storyId: 'button--secondary',
      status: 'booting',
    });

    channel.emit('currentStoryWasSet', { storyId: 'button--secondary', viewMode: 'story' });
    await expect(selecting).resolves.toMatchObject({ generation: 1 });
    protocol.completeCapture('worker-0-2');
    expect(getWorkerSessionIdentity(target)).toBeUndefined();

    await expect(
      protocol.selectStory({ requestId: 'worker-0-3', storyId: 'button--secondary' }),
    ).resolves.toMatchObject({ generation: 2 });
    expect(channel.emitted.at(-1)).toEqual({ eventName: 'forceRemount', args: [] });
  });

  it('rejects overlapping, duplicate, and stale selections', async () => {
    const target = {} as typeof window;
    const channel = new FakeChannel();
    const protocol = initializeWorkerSessionController(target, channel)!;
    const selecting = protocol.selectStory({ requestId: 'worker-0-2', storyId: 'button--secondary' });

    await expect(protocol.selectStory({ requestId: 'worker-0-3', storyId: 'button--tertiary' })).rejects.toThrow(
      'already active',
    );
    channel.emit('currentStoryWasSet', { storyId: 'button--stale' });
    await expect(selecting).rejects.toThrow('requested story button--secondary');
    expect((target as any)[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toMatchObject({ status: 'error' });
    protocol.completeCapture('worker-0-2');
    await expect(protocol.selectStory({ requestId: 'worker-0-2', storyId: 'button--secondary' })).rejects.toThrow(
      'already been used',
    );
  });

  it('publishes render errors for the active request', async () => {
    const target = {} as typeof window;
    const channel = new FakeChannel();
    const protocol = initializeWorkerSessionController(target, channel)!;
    const selecting = protocol.selectStory({ requestId: 'worker-0-2', storyId: 'button--secondary' });

    channel.emit('storyErrored', { title: 'Render failed', description: 'The component threw.' });
    await expect(selecting).rejects.toThrow('The component threw.');
    expect((target as any)[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toMatchObject({
      requestId: 'worker-0-2',
      storyId: 'button--secondary',
      status: 'error',
      error: { message: 'The component threw.' },
    });
  });

  it('disposes listeners and rejects an in-flight selection', async () => {
    const target = {} as typeof window;
    const channel = new FakeChannel();
    const protocol = initializeWorkerSessionController(target, channel)!;
    const selecting = protocol.selectStory({ requestId: 'worker-0-2', storyId: 'button--secondary' });

    protocol.dispose();
    await expect(selecting).rejects.toThrow('disposed during story selection');
    expect((target as any)[STORYFREEZE_WORKER_SESSION_GLOBAL]).toBeUndefined();
    expect([...channel.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
  });

  it('uses Storybook 10 event string fallbacks when a namespace omits an export', () => {
    expect(resolveCoreEvent({}, 'SET_CURRENT_STORY')).toBe('setCurrentStory');
    expect(resolveCoreEvent({}, 'FORCE_REMOUNT')).toBe('forceRemount');
    expect(resolveCoreEvent({ SET_CURRENT_STORY: 'customSetStory' }, 'SET_CURRENT_STORY')).toBe('customSetStory');
  });
});
