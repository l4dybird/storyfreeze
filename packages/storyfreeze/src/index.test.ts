import { describe, expect, expectTypeOf, it, vi } from 'vite-plus/test';
import {
  isScreenshot,
  withScreenshot,
  type ScreenshotOptionFragments,
  type ScreenshotOptionFragmentsForVariant,
  type ScreenshotOptions,
  type StorySessionResetContext,
  type Variants,
  type Viewport,
} from './index.js';

describe('public package contract', () => {
  it('keeps the documented root exports and screenshot options', () => {
    const viewport: Viewport = {
      width: 800,
      height: 600,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      isLandscape: false,
    };
    const fragment: ScreenshotOptionFragments = {
      delay: 1,
      waitAssets: true,
      waitImages: true,
      waitFor: async () => {},
      viewport: 'iPad',
      fullPage: true,
      hover: '#hover',
      focus: '#focus',
      click: '#click',
      skip: false,
      omitBackground: false,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 10, height: 10 },
    };
    const variant: ScreenshotOptionFragmentsForVariant = { ...fragment, extends: ['base'] };
    const variants: Variants = { base: { viewport }, composed: variant };
    const reset = vi.fn(async (_context: StorySessionResetContext) => {});
    const options: ScreenshotOptions = {
      ...fragment,
      viewports: { desktop: viewport, tablet: 'iPad' },
      variants,
      defaultVariantSuffix: 'desktop',
      reset,
    };

    expect(typeof withScreenshot).toBe('function');
    expect(typeof isScreenshot).toBe('function');
    expect(options.reset).toBe(reset);
    expectTypeOf(options).toMatchTypeOf<ScreenshotOptions>();
  });
});
