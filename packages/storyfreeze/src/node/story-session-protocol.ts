import type { CapturePage } from './browser-backend.js';
import { emulationProfileKey, type EmulationProfile } from './emulation-profile.js';
import {
  STORYFREEZE_STORY_SESSION_GLOBAL,
  STORYFREEZE_STORY_SESSION_PROTOCOL_VERSION,
  type OpenStorySessionRequest,
  type ResetVerification,
  type SessionReady,
  type VariantReady,
} from '../shared/preview-protocol.js';

type ProtocolMethod = 'openSession' | 'applyVariant' | 'resetVariant' | 'verifyReset' | 'closeSession';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Story session response.${key} must be a string.`);
  return value;
}

function requirePositiveInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Story session response.${key} must be a positive safe integer.`);
  }
  return Number(value);
}

function validateSessionReady(
  value: unknown,
  expected: { storyId: string; profileHash: string; sessionGeneration?: number },
) {
  if (!isRecord(value)) throw new Error('Story session response must be an object.');
  const ready: SessionReady = {
    storyId: requireString(value, 'storyId'),
    profileHash: requireString(value, 'profileHash'),
    sessionGeneration: requirePositiveInteger(value, 'sessionGeneration'),
  };
  if (
    ready.storyId !== expected.storyId ||
    ready.profileHash !== expected.profileHash ||
    (expected.sessionGeneration !== undefined && ready.sessionGeneration !== expected.sessionGeneration)
  ) {
    throw new Error(
      `Story session generation mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(ready)}.`,
    );
  }
  return ready;
}

function validateVariantReady(
  value: unknown,
  expected: SessionReady & { variantId: string; variantGeneration: number },
) {
  const ready = validateSessionReady(value, expected);
  const record = value as Record<string, unknown>;
  const variantId = requireString(record, 'variantId');
  const variantGeneration = requirePositiveInteger(record, 'variantGeneration');
  if (variantId !== expected.variantId || variantGeneration !== expected.variantGeneration) {
    throw new Error(`Invalid story-session variant generation for ${expected.variantId}.`);
  }
  return { ...ready, variantId, variantGeneration } satisfies VariantReady;
}

function requireNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value !== null && typeof value !== 'string') {
    throw new Error(`Story session response.${key} must be a string or null.`);
  }
  return value as string | null;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') throw new Error(`Story session response.${key} must be a boolean.`);
  return value;
}

function validateResetVerification(value: unknown, expected: SessionReady): ResetVerification {
  const ready = validateSessionReady(value, expected);
  const record = value as Record<string, unknown>;
  return {
    ...ready,
    activeElement: requireNullableString(record, 'activeElement'),
    activeElementMatchesBaseline: requireBoolean(record, 'activeElementMatchesBaseline'),
    baseActiveElement: requireNullableString(record, 'baseActiveElement'),
    argsHash: requireString(record, 'argsHash'),
    baseArgsHash: requireString(record, 'baseArgsHash'),
    baseDocumentFingerprint: requireString(record, 'baseDocumentFingerprint'),
    globalsHash: requireString(record, 'globalsHash'),
    baseGlobalsHash: requireString(record, 'baseGlobalsHash'),
    documentFingerprint: requireString(record, 'documentFingerprint'),
    scrollPositionMatchesBaseline: requireBoolean(record, 'scrollPositionMatchesBaseline'),
  };
}

export function storySessionProfileHash(profile: EmulationProfile): string {
  return emulationProfileKey(profile);
}

export class StorySessionProtocolClient {
  private current?: SessionReady;
  private state: 'closed' | 'ready' | 'applied' | 'poisoned' = 'closed';
  private variantGeneration = 0;
  private activeVariantId?: string;

  constructor(private readonly page: Pick<CapturePage, 'evaluate'>) {}

  async openSession(request: Omit<OpenStorySessionRequest, 'profileHash'> & { profile: EmulationProfile }) {
    if (this.state !== 'closed') throw new Error(`Cannot open a story session from state ${this.state}.`);
    const payload: OpenStorySessionRequest = {
      sessionId: request.sessionId,
      storyId: request.storyId,
      profileHash: storySessionProfileHash(request.profile),
    };
    try {
      const ready = validateSessionReady(await this.invoke('openSession', payload), payload);
      this.current = ready;
      this.variantGeneration = 0;
      this.state = 'ready';
      return ready;
    } catch (error) {
      this.state = 'poisoned';
      throw error;
    }
  }

  async applyVariant(variantId: string): Promise<VariantReady> {
    const current = this.requireState('ready');
    try {
      const ready = validateVariantReady(await this.invoke('applyVariant', variantId), {
        ...current,
        variantId,
        variantGeneration: this.variantGeneration + 1,
      });
      this.variantGeneration = ready.variantGeneration;
      this.activeVariantId = variantId;
      this.state = 'applied';
      return ready;
    } catch (error) {
      this.state = 'poisoned';
      throw error;
    }
  }

  async resetVariant(variantId: string): Promise<SessionReady> {
    const current = this.requireState('applied');
    if (variantId !== this.activeVariantId) {
      this.state = 'poisoned';
      throw new Error(
        `Story session reset expected ${this.activeVariantId ?? 'no active variant'}, received ${variantId}.`,
      );
    }
    try {
      const ready = validateSessionReady(await this.invoke('resetVariant', variantId), current);
      this.activeVariantId = undefined;
      this.state = 'ready';
      return ready;
    } catch (error) {
      this.state = 'poisoned';
      throw error;
    }
  }

  async verifyReset(): Promise<ResetVerification> {
    const current = this.requireState('ready');
    try {
      return validateResetVerification(await this.invoke('verifyReset'), current);
    } catch (error) {
      this.state = 'poisoned';
      throw error;
    }
  }

  async closeSession(): Promise<void> {
    if (this.state === 'closed') return;
    try {
      await this.invoke('closeSession');
    } finally {
      this.current = undefined;
      this.variantGeneration = 0;
      this.activeVariantId = undefined;
      this.state = 'closed';
    }
  }

  private requireState(expected: 'ready' | 'applied') {
    if (!this.current || this.state !== expected) {
      throw new Error(`Story session expected state ${expected}, received ${this.state}.`);
    }
    return this.current;
  }

  private invoke(method: ProtocolMethod, argument?: unknown): Promise<unknown> {
    return this.page.evaluate(
      async ({ argument, globalName, method, protocolVersion }) => {
        const protocol = (window as unknown as Record<string, any>)[globalName];
        if (!protocol || protocol.protocolVersion !== protocolVersion || typeof protocol[method] !== 'function') {
          throw new Error('StoryFreeze story-session preview protocol is unavailable or incompatible.');
        }
        return argument === undefined ? protocol[method]() : protocol[method](argument);
      },
      {
        argument,
        globalName: STORYFREEZE_STORY_SESSION_GLOBAL,
        method,
        protocolVersion: STORYFREEZE_STORY_SESSION_PROTOCOL_VERSION,
      },
    );
  }
}
