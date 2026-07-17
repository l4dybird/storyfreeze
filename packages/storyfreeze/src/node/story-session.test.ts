import { describe, expect, it } from 'vite-plus/test';
import type { PlannedCapture } from './capture-plan.js';
import { classifyBatchEligibility, createStorySessionPlans, createVariantTransition } from './story-session.js';

const desktop = {
  width: 800,
  height: 600,
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
  isLandscape: true,
};

function capture(id: string, variantKey: string[], overrides: Partial<PlannedCapture['options']> = {}): PlannedCapture {
  const profile = overrides.viewport ?? desktop;
  return {
    captureId: id,
    storyId: 'button--primary',
    variantKey,
    profile,
    estimatedCostMs: 500,
    executionMode: variantKey.length === 0 ? 'runtime-discovery' : 'runtime-validation',
    options: {
      captureBeyondViewport: true,
      click: '',
      clip: null,
      delay: 0,
      focus: '',
      fullPage: true,
      hover: '',
      omitBackground: false,
      skip: false,
      viewport: profile,
      waitAssets: true,
      waitImages: false,
      ...overrides,
    },
  };
}

describe(classifyBatchEligibility, () => {
  it('classifies passive variants as safe and requires reset for clicks', () => {
    expect(classifyBatchEligibility(capture('hover', ['hover'], { hover: '#button' }))).toEqual({ mode: 'safe' });
    expect(classifyBatchEligibility(capture('click', ['click'], { click: '#button' }))).toMatchObject({
      mode: 'strict',
    });
    expect(
      classifyBatchEligibility(capture('click', ['click'], { click: '#button' }), { hasCustomReset: true }),
    ).toEqual({ mode: 'validated' });
  });
});

describe(createStorySessionPlans, () => {
  it('groups each emulation class into its own session and batches same-class resizes', () => {
    const base = capture('base', []);
    const hover = capture('hover', ['hover'], { hover: '#button' });
    const resizedProfile = { ...desktop, width: 1024 };
    const resized = capture('resized', ['resized'], { viewport: resizedProfile });
    const mobileProfile = {
      ...desktop,
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
      isLandscape: false,
    };
    const mobile = capture('mobile', ['mobile'], { viewport: mobileProfile });
    const mobileHover = capture('mobile-hover', ['mobile', 'hover'], {
      hover: '#button',
      viewport: mobileProfile,
    });

    const result = createStorySessionPlans({ captures: [base, hover, resized, mobile, mobileHover] }, 'auto');
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.flatMap(session => session.variants.map(variant => variant.capture.captureId))).toEqual([
      'hover',
      'resized',
      'mobile-hover',
    ]);
    expect(result.strictCaptures).toEqual([]);
    expect(createVariantTransition(base, resized).actions).toEqual([{ type: 'viewport', profile: resizedProfile }]);
  });

  it('keeps every capture strict in strict mode and rejects unsafe forced sessions', () => {
    const base = capture('base', []);
    const clicked = capture('clicked', ['clicked'], { click: '#button' });
    clicked.executionMode = 'manifest';
    expect(createStorySessionPlans({ captures: [base, clicked] }, 'strict')).toEqual({
      sessions: [],
      strictCaptures: [base, clicked],
    });
    expect(() => createStorySessionPlans({ captures: [base, clicked] }, 'story-session')).toThrow(
      'not eligible for story-session mode',
    );
  });
});
