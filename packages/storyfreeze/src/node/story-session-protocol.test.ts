import { describe, expect, it, vi } from 'vite-plus/test';
import { StorySessionProtocolClient } from './story-session-protocol.js';

const profile = {
  width: 800,
  height: 600,
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  isLandscape: true,
};

describe(StorySessionProtocolClient, () => {
  it('validates the same session generation across open/apply/reset', async () => {
    const base = { storyId: 'button--primary', sessionGeneration: 2, profileHash: '800:600:1:0:0:1' };
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce({ ...base, variantId: 'hovered', variantGeneration: 1 })
      .mockResolvedValueOnce({ ...base, activeElement: null, pendingRequestCount: 0 })
      .mockResolvedValueOnce(undefined);
    const client = new StorySessionProtocolClient({ evaluate } as never);

    await expect(client.openSession({ sessionId: 'session', storyId: 'button--primary', profile })).resolves.toEqual(
      base,
    );
    await expect(client.applyVariant('hovered')).resolves.toMatchObject({ variantGeneration: 1 });
    await expect(client.resetVariant('hovered')).resolves.toMatchObject({ activeElement: null });
    await expect(client.closeSession()).resolves.toBeUndefined();
  });

  it('rejects stale preview generations', async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({ storyId: 'button--primary', sessionGeneration: 2, profileHash: '800:600:1:0:0:1' })
      .mockResolvedValueOnce({
        storyId: 'button--primary',
        sessionGeneration: 1,
        profileHash: '800:600:1:0:0:1',
        variantId: 'hovered',
        variantGeneration: 1,
      });
    const client = new StorySessionProtocolClient({ evaluate } as never);
    await client.openSession({ sessionId: 'session', storyId: 'button--primary', profile });
    await expect(client.applyVariant('hovered')).rejects.toThrow('generation mismatch');
  });

  it('rejects a repeated variant generation within the current session', async () => {
    const base = { storyId: 'button--primary', sessionGeneration: 2, profileHash: '800:600:1:0:0:1' };
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce({ ...base, variantId: 'hovered', variantGeneration: 1 })
      .mockResolvedValueOnce({ ...base, variantId: 'focused', variantGeneration: 1 });
    const client = new StorySessionProtocolClient({ evaluate } as never);
    await client.openSession({ sessionId: 'session', storyId: 'button--primary', profile });
    await client.applyVariant('hovered');
    await expect(client.applyVariant('focused')).rejects.toThrow('Invalid story-session variant generation');
  });
});
