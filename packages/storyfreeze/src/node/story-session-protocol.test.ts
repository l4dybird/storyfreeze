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
  const verification = (base: Record<string, unknown>) => ({
    ...base,
    activeElement: null,
    activeElementMatchesBaseline: true,
    baseActiveElement: null,
    argsHash: 'args',
    baseArgsHash: 'args',
    baseDocumentFingerprint: 'document',
    globalsHash: 'globals',
    baseGlobalsHash: 'globals',
    documentFingerprint: 'document',
    scrollPositionMatchesBaseline: true,
  });

  it('validates the same session generation across open/apply/reset/verify', async () => {
    const base = { storyId: 'button--primary', sessionGeneration: 2, profileHash: '800:600:1:0:0:1' };
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce({ ...base, variantId: 'hovered', variantGeneration: 1 })
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce(verification(base))
      .mockResolvedValueOnce(undefined);
    const client = new StorySessionProtocolClient({ evaluate } as never);

    await expect(client.openSession({ sessionId: 'session', storyId: 'button--primary', profile })).resolves.toEqual(
      base,
    );
    await expect(client.resetVariant('__base__')).resolves.toEqual(base);
    await expect(client.applyVariant('hovered')).resolves.toMatchObject({ variantGeneration: 1 });
    await expect(client.resetVariant('hovered')).resolves.toEqual(base);
    await expect(client.verifyReset()).resolves.toMatchObject({ activeElement: null });
    await expect(client.closeSession()).resolves.toBeUndefined();
    expect(evaluate.mock.calls.map(([, payload]) => payload.method)).toEqual([
      'openSession',
      'resetVariant',
      'applyVariant',
      'resetVariant',
      'verifyReset',
      'closeSession',
    ]);
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
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce({ ...base, variantId: 'focused', variantGeneration: 1 });
    const client = new StorySessionProtocolClient({ evaluate } as never);
    await client.openSession({ sessionId: 'session', storyId: 'button--primary', profile });
    await client.applyVariant('hovered');
    await client.resetVariant('hovered');
    await expect(client.applyVariant('focused')).rejects.toThrow('Invalid story-session variant generation');
  });

  it('rejects an open response without a positive session generation', async () => {
    const evaluate = vi.fn().mockResolvedValueOnce({
      storyId: 'button--primary',
      profileHash: '800:600:1:0:0:1',
    });
    const client = new StorySessionProtocolClient({ evaluate } as never);

    await expect(client.openSession({ sessionId: 'session', storyId: 'button--primary', profile })).rejects.toThrow(
      'sessionGeneration must be a positive safe integer',
    );
  });

  it('rejects incomplete reset verification responses', async () => {
    const base = { storyId: 'button--primary', sessionGeneration: 2, profileHash: '800:600:1:0:0:1' };
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce({ ...base, activeElement: null });
    const client = new StorySessionProtocolClient({ evaluate } as never);
    await client.openSession({ sessionId: 'session', storyId: 'button--primary', profile });

    await expect(client.verifyReset()).rejects.toThrow('activeElementMatchesBaseline must be a boolean');
  });

  it('requires a reset before applying another variant', async () => {
    const base = { storyId: 'button--primary', sessionGeneration: 2, profileHash: '800:600:1:0:0:1' };
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce({ ...base, variantId: 'hovered', variantGeneration: 1 });
    const client = new StorySessionProtocolClient({ evaluate } as never);
    await client.openSession({ sessionId: 'session', storyId: 'button--primary', profile });
    await client.applyVariant('hovered');

    await expect(client.applyVariant('focused')).rejects.toThrow('expected state ready, received applied');
  });
});
