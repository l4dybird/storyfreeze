import { describe, expect, it } from 'vite-plus/test';
import { addViewportProfileTags, resolveStoryFileTestRegexp, storyfreezeViewportIndexer } from './viewport-indexer.js';

const options = { makeTitle: (title?: string) => title ?? '' };

function tagsByStory(code: string, prefix: string) {
  return Object.fromEntries(
    addViewportProfileTags(code, '/fixture/Example.stories.ts', options)
      .filter(input => input.type === 'story' && input.subtype !== 'test')
      .map(input => [input.exportName, (input.tags ?? []).filter(tag => tag.startsWith(prefix))]),
  );
}

/** Viewport hints only; every story also carries a cost tag, asserted separately. */
function storyTags(code: string) {
  return tagsByStory(code, 'storyfreeze-viewport-');
}

function costTags(code: string) {
  return tagsByStory(code, 'storyfreeze-cost-');
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

  it('hints StoryFreeze screenshot viewports, which are what users actually configure', () => {
    expect(
      storyTags(`
        export default { title: 'Example' };
        export const Named = { parameters: { screenshot: { viewport: 'iPad' } } };
        export const Dimensions = { parameters: { screenshot: { viewport: '800x600' } } };
        export const Inline = {
          parameters: { screenshot: { viewport: { width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true } } },
        };
        export const Minimal = { parameters: { screenshot: { viewport: { width: 1200, height: 800 } } } };
        export const Landscape = { parameters: { screenshot: { viewport: { width: 800, height: 1200, isLandscape: true } } } };
        export const Dynamic = { parameters: { screenshot: { viewport: { width: computeWidth(), height: 600 } } } };
        export const DynamicScale = {
          parameters: { screenshot: { viewport: { width: 375, height: 667, deviceScaleFactor: computeScale() } } },
        };
        export const DynamicTouch = {
          parameters: { screenshot: { viewport: { width: 375, height: 667, hasTouch: computeTouch() } } },
        };
        export const DynamicOrientation = {
          parameters: { screenshot: { viewport: { width: 375, height: 667, isLandscape: computeLandscape() } } },
        };
      `),
    ).toEqual({
      Named: ['storyfreeze-viewport-iPad'],
      Dimensions: ['storyfreeze-viewport-800x600'],
      // Fixed field order so two stories describing the same emulation agree.
      Inline: ['storyfreeze-viewport-obj%3A375x667%402%3Am1%3At1%3Aoauto'],
      Minimal: ['storyfreeze-viewport-obj%3A1200x800%401%3Am0%3At0%3Aoauto'],
      Landscape: ['storyfreeze-viewport-obj%3A800x1200%401%3Am0%3At0%3Aolandscape'],
      // Not statically resolvable, so no hint rather than a guess.
      Dynamic: [],
      DynamicOrientation: [],
      DynamicScale: [],
      DynamicTouch: [],
    });
  });

  it('uses the first viewports entry as the root hint, matching expandViewportsOption', () => {
    expect(
      storyTags(`
        export default {
          title: 'Example',
          parameters: { screenshot: { viewports: { DESKTOP: { width: 1200, height: 800 }, MOBILE: { width: 390, height: 844 } } } },
        };
        export const Inherited = {};
        export const ByName = { parameters: { screenshot: { viewports: ['iPad', 'iPhone 12'] } } };
        export const Spread = { parameters: { screenshot: { viewports: { ...shared } } } };
      `),
    ).toEqual({
      Inherited: ['storyfreeze-viewport-obj%3A1200x800%401%3Am0%3At0%3Aoauto'],
      ByName: ['storyfreeze-viewport-iPad'],
      Spread: [],
    });
  });

  it('mirrors Storybook recursive parameter merging for viewport hints', () => {
    expect(
      storyTags(`
        export default {
          title: 'Example',
          parameters: {
            screenshot: {
              viewport: { width: 1200, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
            },
          },
        };
        export const InheritedFields = {
          parameters: { screenshot: { viewport: { width: 400, height: 800 } } },
        };
      `),
    ).toEqual({
      InheritedFields: ['storyfreeze-viewport-obj%3A400x800%402%3Am1%3At1%3Aoauto'],
    });

    expect(
      storyTags(`
        export default {
          title: 'Example',
          parameters: {
            screenshot: {
              viewport: { width: 900, height: 600 },
              viewports: {
                META_ROOT: { width: 1200, height: 800, deviceScaleFactor: 2 },
                META_ALT: { width: 800, height: 1000 },
              },
            },
          },
        };
        export const StoryViewport = {
          parameters: { screenshot: { viewport: { width: 400, height: 800 } } },
        };
        export const AddedViewports = {
          parameters: {
            screenshot: {
              viewports: {
                STORY_ROOT: { width: 1000, height: 700 },
                STORY_ALT: { width: 390, height: 844 },
              },
            },
          },
        };
        export const ReplacedByArray = {
          parameters: { screenshot: { viewports: ['iPad', 'iPhone 12'] } },
        };
      `),
    ).toEqual({
      // Inherited viewports still take precedence over viewport after Storybook
      // recursively merges the screenshot parameter.
      StoryViewport: ['storyfreeze-viewport-obj%3A1200x800%402%3Am0%3At0%3Aoauto'],
      // Object keys from the meta stay first; story keys are appended.
      AddedViewports: ['storyfreeze-viewport-obj%3A1200x800%402%3Am0%3At0%3Aoauto'],
      // Arrays replace earlier parameter values in Storybook.
      ReplacedByArray: ['storyfreeze-viewport-iPad'],
    });
  });

  it('prefers StoryFreeze options over Storybook viewport globals', () => {
    expect(
      storyTags(`
        export default { title: 'Example', globals: { viewport: 'desktop' } };
        export const FromGlobals = {};
        export const FromScreenshot = { parameters: { screenshot: { viewport: 'iPad' } } };
        export const DynamicScreenshot = {
          globals: { viewport: 'mobile' },
          parameters: { screenshot: { viewport: computeViewport() } },
        };
      `),
    ).toEqual({
      DynamicScreenshot: [],
      FromGlobals: ['storyfreeze-viewport-desktop'],
      FromScreenshot: ['storyfreeze-viewport-iPad'],
    });
  });

  it('estimates cost from the capture count and the static delay', () => {
    expect(
      costTags(`
        export default { title: 'Example' };
        export const Plain = {};
        export const Delayed = { parameters: { screenshot: { delay: 250 } } };
        export const Variants = { parameters: { screenshot: { variants: { hovered: {}, focused: {} } } } };
        export const Viewports = {
          parameters: { screenshot: { viewports: { A: { width: 800, height: 600 }, B: { width: 400, height: 800 } } } },
        };
        export const Both = {
          parameters: {
            screenshot: {
              delay: 100,
              variants: { hovered: {} },
              viewports: { A: { width: 800, height: 600 }, hovered: { width: 400, height: 800 } },
            },
          },
        };
        export const Dynamic = { parameters: { screenshot: { delay: computeDelay() } } };
      `),
    ).toEqual({
      // One capture at the default cost.
      Plain: ['storyfreeze-cost-v1-500'],
      Delayed: ['storyfreeze-cost-v1-750'],
      // Root plus two variants.
      Variants: ['storyfreeze-cost-v1-1500'],
      // Root plus the non-root viewport.
      Viewports: ['storyfreeze-cost-v1-1000'],
      // `hovered` appears in both maps and must be counted once: root + hovered.
      Both: ['storyfreeze-cost-v1-1200'],
      // Unresolvable delay falls back to the default rather than guessing.
      Dynamic: ['storyfreeze-cost-v1-500'],
    });
  });

  it('inherits meta delay and unions meta variants into the estimate', () => {
    expect(
      costTags(`
        export default { title: 'Example', parameters: { screenshot: { delay: 200, variants: { hovered: {} } } } };
        export const Inherited = {};
        export const OwnDelay = { parameters: { screenshot: { delay: 0 } } };
        export const DynamicDelay = { parameters: { screenshot: { delay: computeDelay() } } };
        export const OwnVariants = { parameters: { screenshot: { variants: { focused: {} } } } };
      `),
    ).toEqual({
      // Root + hovered, each paying the 200 ms meta delay.
      Inherited: ['storyfreeze-cost-v1-1400'],
      OwnDelay: ['storyfreeze-cost-v1-1000'],
      // The dynamic story value overrides meta delay, but the inherited static
      // variant count is still known.
      DynamicDelay: ['storyfreeze-cost-v1-1000'],
      // Meta's hovered and the story's focused both apply.
      OwnVariants: ['storyfreeze-cost-v1-2100'],
    });
  });

  it('counts recursively merged meta and story viewports', () => {
    expect(
      costTags(`
        export default {
          title: 'Example',
          parameters: {
            screenshot: {
              viewports: {
                META_ROOT: { width: 1200, height: 800 },
                META_ALT: { width: 800, height: 1000 },
              },
            },
          },
        };
        export const AddedViewports = {
          parameters: {
            screenshot: {
              viewports: {
                STORY_ROOT: { width: 1000, height: 700 },
                STORY_ALT: { width: 390, height: 844 },
              },
            },
          },
        };
        export const ReplacedByArray = {
          parameters: { screenshot: { viewports: ['iPad', 'iPhone 12'] } },
        };
      `),
    ).toEqual({
      AddedViewports: ['storyfreeze-cost-v1-2000'],
      ReplacedByArray: ['storyfreeze-cost-v1-1000'],
    });
  });
});

describe(resolveStoryFileTestRegexp, () => {
  it('uses the Storybook 10.5 matcher when the internal export is unavailable', () => {
    const matcher = resolveStoryFileTestRegexp({});

    expect(matcher).toEqual(/(stories|story)\.(m?js|ts)x?$/);
    expect(matcher.test('/fixture/Example.stories.ts')).toBe(true);
    expect(matcher.test('/fixture/Example.story.mjs')).toBe(true);
    expect(matcher.test('/fixture/Example.stories.mdx')).toBe(false);
  });

  it('uses Storybook-provided matcher when it is available', () => {
    const matcher = /custom-story$/;

    expect(resolveStoryFileTestRegexp({ STORY_FILE_TEST_REGEXP: matcher })).toBe(matcher);
    expect(storyfreezeViewportIndexer.test).toBeInstanceOf(RegExp);
  });
});
