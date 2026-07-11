import metadata from '../../package.json' with { type: 'json' };
import type { ScreenshotOptionFragmentsForVariant, ScreenshotOptions } from './types.js';

export const STORYFREEZE_PREVIEW_STATE_GLOBAL = '__STORYFREEZE_PREVIEW_STATE__';
export const STORYFREEZE_REQUEST_ID_PARAM = 'storyfreezeRequestId';
export const STORYFREEZE_PREVIEW_PROTOCOL_VERSION = 1 as const;
export const STORYFREEZE_ADDON_VERSION = metadata.version;

export type NormalizedScreenshotOptions = Omit<ScreenshotOptions, 'waitFor' | 'variants'> & {
  variants?: Record<string, Omit<ScreenshotOptionFragmentsForVariant, 'waitFor'>>;
};

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

interface PreviewStateBaseV1 {
  protocolVersion: typeof STORYFREEZE_PREVIEW_PROTOCOL_VERSION;
  addonVersion: string;
  requestId: string;
  storyId: string;
}

export type StoryFreezePreviewStateV1 =
  | (PreviewStateBaseV1 & { status: 'booting' })
  | (PreviewStateBaseV1 & { status: 'ready'; options: NormalizedScreenshotOptions })
  | (PreviewStateBaseV1 & { status: 'error'; error: SerializedError });

export function createPreviewStateBase(storyId: string, requestId: string): PreviewStateBaseV1 {
  return {
    protocolVersion: STORYFREEZE_PREVIEW_PROTOCOL_VERSION,
    addonVersion: STORYFREEZE_ADDON_VERSION,
    requestId,
    storyId,
  };
}
