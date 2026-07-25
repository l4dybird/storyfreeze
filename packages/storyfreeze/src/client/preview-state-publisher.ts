import {
  STORYFREEZE_NOTIFY_STATE_CHANGED_BINDING,
  STORYFREEZE_PREVIEW_STATE_GLOBAL,
  type StoryFreezePreviewStateV1,
} from '../shared/preview-protocol.js';

export type PreviewStateTarget = typeof window & {
  [STORYFREEZE_PREVIEW_STATE_GLOBAL]?: StoryFreezePreviewStateV1;
  [STORYFREEZE_NOTIFY_STATE_CHANGED_BINDING]?: (status: StoryFreezePreviewStateV1['status']) => Promise<void>;
};

/** Publish authoritative state first, then wake the optional Node-side waiter. */
export function publishPreviewState(target: PreviewStateTarget, state: StoryFreezePreviewStateV1): void {
  target[STORYFREEZE_PREVIEW_STATE_GLOBAL] = state;
  try {
    // The status lets the Node side ignore intermediate transitions instead of
    // re-reading the state global for every one of them.
    void target[STORYFREEZE_NOTIFY_STATE_CHANGED_BINDING]?.(state.status).catch(() => undefined);
  } catch {
    // The global state remains authoritative when the exposed binding is unavailable.
  }
}
