import metadata from '../../package.json' with { type: 'json' };
import type { ScreenshotOptionFragmentsForVariant, ScreenshotOptions } from './types.js';

export const STORYFREEZE_PREVIEW_STATE_GLOBAL = '__STORYFREEZE_PREVIEW_STATE__';
export const STORYFREEZE_REQUEST_ID_PARAM = 'storyfreezeRequestId';
export const STORYFREEZE_PREVIEW_PROTOCOL_VERSION = 1 as const;
export const STORYFREEZE_ADDON_VERSION = metadata.version;

export type NormalizedScreenshotOptions = Omit<ScreenshotOptions, 'reset' | 'waitFor' | 'variants'> & {
  variants?: Record<string, Omit<ScreenshotOptionFragmentsForVariant, 'waitFor'>>;
};

export interface PreviewRuntimeMetadata {
  hasCustomReset: boolean;
  hasRuntimeWaitFor: boolean;
  runtimeWaitForVariants: string[];
}

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
  | (PreviewStateBaseV1 & {
      status: 'ready';
      options: NormalizedScreenshotOptions;
      rootOptions?: NormalizedScreenshotOptions;
      runtime?: PreviewRuntimeMetadata;
    })
  | (PreviewStateBaseV1 & { status: 'error'; error: SerializedError });

export function createPreviewStateBase(storyId: string, requestId: string): PreviewStateBaseV1 {
  return {
    protocolVersion: STORYFREEZE_PREVIEW_PROTOCOL_VERSION,
    addonVersion: STORYFREEZE_ADDON_VERSION,
    requestId,
    storyId,
  };
}

export const STORYFREEZE_STORY_SESSION_GLOBAL = '__STORYFREEZE_STORY_SESSION__';
export const STORYFREEZE_STORY_SESSION_PROTOCOL_VERSION = 1 as const;

export interface OpenStorySessionRequest {
  sessionId: string;
  storyId: string;
  profileHash: string;
}

export interface SessionReady {
  storyId: string;
  sessionGeneration: number;
  profileHash: string;
}

export interface VariantReady extends SessionReady {
  variantId: string;
  variantGeneration: number;
}

export interface ResetVerification extends SessionReady {
  activeElement: string | null;
  activeElementMatchesBaseline?: boolean;
  baseActiveElement?: string | null;
  argsHash?: string;
  baseArgsHash?: string;
  globalsHash?: string;
  baseGlobalsHash?: string;
  pendingRequestCount: number;
  baseRootFingerprint?: string;
  rootFingerprint?: string;
}

export interface StorySessionPreviewProtocol {
  protocolVersion: typeof STORYFREEZE_STORY_SESSION_PROTOCOL_VERSION;
  openSession(request: OpenStorySessionRequest): Promise<SessionReady>;
  applyVariant(variantId: string): Promise<VariantReady>;
  resetVariant(variantId: string): Promise<ResetVerification>;
  closeSession(): Promise<void>;
}
