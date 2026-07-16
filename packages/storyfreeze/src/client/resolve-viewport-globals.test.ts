import { describe, expect, it } from 'vite-plus/test';
import { createBaseScreenshotOptions, mergeScreenshotOptions } from '../shared/screenshot-options-helper.js';
import type { ScreenshotOptions } from '../shared/types.js';
import {
  applyViewportFromGlobals,
  resolveViewportFromGlobals,
  type StoryContextLike,
} from './resolve-viewport-globals.js';

const viewportOptions = {
  mobile: { styles: { width: '414px', height: '896px' } },
  desktop: { styles: { width: '1280px', height: '720px' } },
};

describe(resolveViewportFromGlobals, () => {
  it('resolves the selected viewport and prefers story globals over globals', () => {
    expect(
      resolveViewportFromGlobals({
        storyGlobals: { viewport: { value: 'desktop' } },
        globals: { viewport: { value: 'mobile' } },
        parameters: { viewport: { options: viewportOptions } },
      }),
    ).toEqual({ width: 1280, height: 720 });
  });

  it('supports string globals and swaps dimensions when rotated', () => {
    expect(
      resolveViewportFromGlobals({
        globals: { viewport: 'mobile' },
        parameters: { viewport: { options: viewportOptions } },
      }),
    ).toEqual({ width: 414, height: 896 });

    expect(
      resolveViewportFromGlobals({
        globals: { viewport: { value: 'mobile', isRotated: true } },
        parameters: { viewport: { options: viewportOptions } },
      }),
    ).toEqual({ width: 896, height: 414 });
  });

  it('falls back to defaultViewport and supports the legacy viewports map', () => {
    expect(
      resolveViewportFromGlobals({
        parameters: {
          viewport: {
            defaultViewport: 'numeric',
            viewports: { numeric: { styles: { width: 1024, height: 768 } } },
          },
        },
      }),
    ).toEqual({ width: 1024, height: 768 });
  });

  it.each([
    ['an unknown name', { globals: { viewport: 'unknown' }, parameters: { viewport: { options: viewportOptions } } }],
    ['missing styles', { globals: { viewport: 'desktop' }, parameters: { viewport: { options: { desktop: {} } } } }],
    [
      'an invalid width',
      {
        globals: { viewport: 'desktop' },
        parameters: { viewport: { options: { desktop: { styles: { width: 'auto', height: '720px' } } } } },
      },
    ],
    [
      'an invalid height',
      {
        globals: { viewport: 'desktop' },
        parameters: { viewport: { options: { desktop: { styles: { width: '1280px', height: 'auto' } } } } },
      },
    ],
  ] satisfies [string, StoryContextLike][])('returns undefined for %s', (_label, context) => {
    expect(resolveViewportFromGlobals(context)).toBeUndefined();
  });
});

describe(applyViewportFromGlobals, () => {
  const context: StoryContextLike = {
    globals: { viewport: { value: 'desktop' } },
    parameters: { viewport: { options: viewportOptions } },
  };

  it.each([
    { viewport: { width: 900, height: 600 } },
    { viewports: ['1024x768', '414x896'] },
  ] satisfies ScreenshotOptions[])('does not overwrite explicit StoryFreeze viewport options', screenshotOptions => {
    expect(applyViewportFromGlobals(screenshotOptions, context)).toBe(screenshotOptions);
  });

  it('injects only a single viewport and leaves filename suffix fields unchanged', () => {
    const screenshotOptions: ScreenshotOptions = {
      fullPage: true,
      variants: { dark: { omitBackground: true } },
      defaultVariantSuffix: 'existing',
    };
    const injected = applyViewportFromGlobals(screenshotOptions, context);

    expect(injected).toEqual({
      fullPage: true,
      viewport: { width: 1280, height: 720 },
      variants: { dark: { omitBackground: true } },
      defaultVariantSuffix: 'existing',
    });
    expect(injected).not.toHaveProperty('viewports');

    const suffixFree = applyViewportFromGlobals({ fullPage: true }, context);
    expect(suffixFree).not.toHaveProperty('variants');
    expect(suffixFree).not.toHaveProperty('defaultVariantSuffix');

    const cliDefaults = createBaseScreenshotOptions({
      delay: 0,
      disableWaitAssets: false,
      viewports: ['800x600'],
    });
    const merged = mergeScreenshotOptions(cliDefaults, suffixFree);
    expect(merged.viewport).toEqual({ width: 1280, height: 720 });
    expect(merged.variants).toEqual({});
    expect(merged.defaultVariantSuffix).toBe('');
  });

  it('returns the original options when globals cannot be resolved', () => {
    const screenshotOptions: ScreenshotOptions = { fullPage: true };
    expect(
      applyViewportFromGlobals(screenshotOptions, {
        globals: { viewport: 'unknown' },
        parameters: { viewport: { options: viewportOptions } },
      }),
    ).toBe(screenshotOptions);
  });
});
