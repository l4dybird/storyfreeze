import { describe, expect, it } from 'vite-plus/test';
import { createStoryCostTag, parseStoryCostTag, STORYFREEZE_DEFAULT_STORY_COST_MS } from './story-cost-tag.js';

describe('story cost tags', () => {
  it('normalizes finite costs and falls back for invalid estimates', () => {
    expect(createStoryCostTag(519.4)).toBe('storyfreeze-cost-v1-519');
    expect(createStoryCostTag(Number.POSITIVE_INFINITY)).toBe(
      `storyfreeze-cost-v1-${STORYFREEZE_DEFAULT_STORY_COST_MS}`,
    );
  });

  it('accepts only positive safe-integer v1 tags', () => {
    expect(parseStoryCostTag('storyfreeze-cost-v1-519')).toBe(519);
    expect(parseStoryCostTag('storyfreeze-cost-v2-519')).toBeUndefined();
    expect(parseStoryCostTag('storyfreeze-cost-v1-0')).toBeUndefined();
    expect(parseStoryCostTag('storyfreeze-cost-v1-1.5')).toBeUndefined();
    expect(parseStoryCostTag('storyfreeze-cost-v1-9007199254740992')).toBeUndefined();
  });
});
