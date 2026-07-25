import { describe, expect, it, vi } from 'vite-plus/test';
import {
  STORYFREEZE_NOTIFY_STATE_CHANGED_BINDING,
  STORYFREEZE_PREVIEW_STATE_GLOBAL,
  createPreviewStateBase,
  type StoryFreezePreviewStateV1,
} from '../shared/preview-protocol.js';
import { publishPreviewState, type PreviewStateTarget } from './preview-state-publisher.js';

describe(publishPreviewState, () => {
  it('stores authoritative state before invoking the optional notification', async () => {
    const state: StoryFreezePreviewStateV1 = {
      ...createPreviewStateBase('button--primary', '0-1'),
      status: 'booting',
    };
    const target = {} as PreviewStateTarget;
    target[STORYFREEZE_NOTIFY_STATE_CHANGED_BINDING] = vi.fn(async () => {
      expect(target[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toBe(state);
    });

    publishPreviewState(target, state);
    await vi.waitFor(() => expect(target[STORYFREEZE_NOTIFY_STATE_CHANGED_BINDING]).toHaveBeenCalledOnce());
  });

  it('keeps state published when notification rejects', async () => {
    const state: StoryFreezePreviewStateV1 = {
      ...createPreviewStateBase('button--primary', '0-1'),
      status: 'booting',
    };
    const target = {
      [STORYFREEZE_NOTIFY_STATE_CHANGED_BINDING]: vi.fn(async () => Promise.reject(new Error('closed'))),
    } as unknown as PreviewStateTarget;

    expect(() => publishPreviewState(target, state)).not.toThrow();
    expect(target[STORYFREEZE_PREVIEW_STATE_GLOBAL]).toBe(state);
  });
});
