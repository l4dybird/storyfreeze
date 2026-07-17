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

function assertSessionReady(
  value: SessionReady,
  expected: { storyId: string; profileHash: string; sessionGeneration?: number },
) {
  if (
    value.storyId !== expected.storyId ||
    value.profileHash !== expected.profileHash ||
    (expected.sessionGeneration !== undefined && value.sessionGeneration !== expected.sessionGeneration)
  ) {
    throw new Error(
      `Story session generation mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(value)}.`,
    );
  }
}

export function storySessionProfileHash(profile: EmulationProfile): string {
  return emulationProfileKey(profile);
}

export class StorySessionProtocolClient {
  private current?: SessionReady;
  private variantGeneration = 0;

  constructor(private readonly page: Pick<CapturePage, 'evaluate'>) {}

  async openSession(request: Omit<OpenStorySessionRequest, 'profileHash'> & { profile: EmulationProfile }) {
    const payload: OpenStorySessionRequest = {
      sessionId: request.sessionId,
      storyId: request.storyId,
      profileHash: storySessionProfileHash(request.profile),
    };
    const ready = await this.page.evaluate(
      async ({ globalName, protocolVersion, payload }) => {
        const protocol = (window as unknown as Record<string, any>)[globalName];
        if (!protocol || protocol.protocolVersion !== protocolVersion) {
          throw new Error('StoryFreeze story-session preview protocol is unavailable or incompatible.');
        }
        return protocol.openSession(payload) as Promise<SessionReady>;
      },
      {
        globalName: STORYFREEZE_STORY_SESSION_GLOBAL,
        protocolVersion: STORYFREEZE_STORY_SESSION_PROTOCOL_VERSION,
        payload,
      },
    );
    assertSessionReady(ready, payload);
    this.current = ready;
    this.variantGeneration = 0;
    return ready;
  }

  async applyVariant(variantId: string): Promise<VariantReady> {
    const current = this.requireCurrent();
    const ready = await this.page.evaluate(
      async ({ globalName, variantId }) => {
        const protocol = (window as unknown as Record<string, any>)[globalName];
        return protocol.applyVariant(variantId) as Promise<VariantReady>;
      },
      { globalName: STORYFREEZE_STORY_SESSION_GLOBAL, variantId },
    );
    assertSessionReady(ready, current);
    if (
      ready.variantId !== variantId ||
      !Number.isSafeInteger(ready.variantGeneration) ||
      ready.variantGeneration !== this.variantGeneration + 1
    ) {
      throw new Error(`Invalid story-session variant generation for ${variantId}.`);
    }
    this.variantGeneration = ready.variantGeneration;
    return ready;
  }

  async resetVariant(variantId: string): Promise<SessionReady> {
    const current = this.requireCurrent();
    const ready = await this.page.evaluate(
      async ({ globalName, variantId }) => {
        const protocol = (window as unknown as Record<string, any>)[globalName];
        return protocol.resetVariant(variantId) as Promise<SessionReady>;
      },
      { globalName: STORYFREEZE_STORY_SESSION_GLOBAL, variantId },
    );
    assertSessionReady(ready, current);
    return ready;
  }

  async verifyReset(): Promise<ResetVerification> {
    const current = this.requireCurrent();
    const verification = await this.page.evaluate(async globalName => {
      const protocol = (window as unknown as Record<string, any>)[globalName];
      return protocol.verifyReset() as Promise<ResetVerification>;
    }, STORYFREEZE_STORY_SESSION_GLOBAL);
    assertSessionReady(verification, current);
    return verification;
  }

  async closeSession(): Promise<void> {
    if (!this.current) return;
    this.current = undefined;
    this.variantGeneration = 0;
    await this.page.evaluate(async globalName => {
      const protocol = (window as unknown as Record<string, any>)[globalName];
      await protocol?.closeSession();
    }, STORYFREEZE_STORY_SESSION_GLOBAL);
  }

  private requireCurrent() {
    if (!this.current) throw new Error('Story session has not been opened.');
    return this.current;
  }
}
