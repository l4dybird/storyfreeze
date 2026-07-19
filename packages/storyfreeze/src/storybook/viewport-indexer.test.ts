import { describe, expect, it } from 'vite-plus/test';
import { addViewportProfileTags } from './viewport-indexer.js';

const options = { makeTitle: (title: string) => title };

function storyTags(code: string) {
  return Object.fromEntries(
    addViewportProfileTags(code, '/fixture/Example.stories.ts', options)
      .filter(input => input.type === 'story' && input.subtype !== 'test')
      .map(input => [input.exportName, input.tags ?? []]),
  );
}

describe(addViewportProfileTags, () => {
  it('adds readable viewport tags for literal story globals', () => {
    expect(
      storyTags(`
        export default { title: 'Example' };
        export const Desktop = { globals: { viewport: { value: 'desktop' } } };
        export const Mobile = { globals: { viewport: 'mobile portrait' } };
      `),
    ).toEqual({
      Desktop: ['storyfreeze-viewport-desktop'],
      Mobile: ['storyfreeze-viewport-mobile%20portrait'],
    });
  });

  it('resolves local spreads and lets the final story property win', () => {
    expect(
      storyTags(`
        const desktop = { globals: { viewport: { value: 'desktop' } } };
        export default { title: 'Example' };
        export const Spread = { ...desktop, args: { label: 'spread' } };
        export const Override = { ...desktop, globals: { viewport: { value: 'mobile' } } };
        export const UnknownOverride = { ...desktop, ...getRuntimeStory() };
      `),
    ).toEqual({
      Override: ['storyfreeze-viewport-mobile'],
      Spread: ['storyfreeze-viewport-desktop'],
      UnknownOverride: [],
    });
  });

  it('uses a static meta viewport only when the story has no static override', () => {
    expect(
      storyTags(`
        const mobile = { value: 'mobile' };
        export default { title: 'Example', globals: { viewport: { value: 'desktop' } } };
        export const Inherited = {};
        export const Override = { globals: { viewport: mobile } };
        export const Dynamic = { globals: getRuntimeGlobals() };
      `),
    ).toEqual({
      Dynamic: [],
      Inherited: ['storyfreeze-viewport-desktop'],
      Override: ['storyfreeze-viewport-mobile'],
    });
  });
});
